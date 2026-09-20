import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  PendingBranchCandidate,
  PendingRemoteBranchPruneItem,
  PendingRemoteBranchTarget,
} from "../../types";
import { toPruneTarget } from "./pendingMr";

/** 扫描结果里带的项目根（删除时按 project_path 做仓库路径边界校验）。 */
interface ScopedScan {
  path: string;
  projectPath: string;
}

/**
 * 批量删除远端分支的**两阶段**流程（dry-run 扫描 → 确认弹层 → 逐条回执）。
 *
 * 抽成 hook 而不是留在视图里：这套状态机（`pruneBusy` / `pruneResults` / `pending` 三个
 * 状态加两个异步步骤）与列表渲染无关，独立出来后视图只负责把选中的分支和刷新回调交给它。
 *
 * 后端按 `project_path` 校验仓库路径是否在项目内，故调用要**按项目分组**发送。
 */
export function useRemoteBranchPrune({
  scans,
  selectedDeletable,
  refresh,
  clearSelection,
  setError,
  setNotice,
}: {
  scans: ScopedScan[];
  /** 当前已选中且可删的分支（不可删的不会进入这个列表）。 */
  selectedDeletable: PendingBranchCandidate[];
  /** 删除完成后重跑扫描。 */
  refresh: () => void;
  clearSelection: () => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const [pruneBusy, setPruneBusy] = useState(false);
  const [pruneResults, setPruneResults] = useState<PendingRemoteBranchPruneItem[]>([]);
  const [pending, setPending] = useState<PendingRemoteBranchTarget[] | null>(null);

  /** 把待处理项按项目根分组——后端以 project_path 为边界校验仓库路径。 */
  const groupByProject = useCallback(
    <T extends { repoPath: string }>(items: T[]): Map<string, T[]> => {
      const groups = new Map<string, T[]>();
      for (const item of items) {
        const projectPath = scans.find((scan) => scan.path === item.repoPath)?.projectPath ?? "";
        groups.set(projectPath, [...(groups.get(projectPath) ?? []), item]);
      }
      return groups;
    },
    [scans],
  );

  /** 第一步：dry-run 扫描，不做任何写操作。 */
  const startPrune = useCallback(async () => {
    if (selectedDeletable.length === 0) return;
    setError("");
    setNotice("");
    setPruneBusy(true);
    try {
      const collect: PendingRemoteBranchPruneItem[] = [];
      for (const [projectPath, branches] of groupByProject(selectedDeletable)) {
        const result = await invoke<PendingRemoteBranchPruneItem[]>("prune_remote_branches", {
          projectPath,
          items: branches.map(toPruneTarget),
          dryRun: true,
        });
        collect.push(...result);
      }
      const deletable = collect.filter((item) => item.deletable);
      if (deletable.length === 0) {
        // 没有任何一条通过门禁：把逐条原因摊开给用户看，不必弹确认框（也没得确认）。
        setPruneResults(collect);
        setNotice("所选分支均不满足删除条件，未执行删除。");
        return;
      }
      // 有可删项时不写结果面板——此时断言「删除失败」是错的，用户还没确认。
      setPending(deletable.map(({ repoPath, repo, branch, targetBranch }) => ({
        repoPath,
        repo,
        branch,
        targetBranch,
      })));
    } catch (e) {
      setError(String(e));
    } finally {
      setPruneBusy(false);
    }
  }, [selectedDeletable, groupByProject, setError, setNotice]);

  /** 第二步：用户确认后才真删。单条失败不中断整批（后端逐条返回回执）。 */
  const confirmPrune = useCallback(async () => {
    setPruneBusy(true);
    try {
      const done: PendingRemoteBranchPruneItem[] = [];
      for (const [projectPath, items] of groupByProject(pending ?? [])) {
        const result = await invoke<PendingRemoteBranchPruneItem[]>("prune_remote_branches", {
          projectPath,
          items,
          dryRun: false,
        });
        done.push(...result);
      }
      setPruneResults(done);
      const deleted = done.filter((item) => item.deleted).length;
      const failed = done.filter((item) => item.deletable && !item.deleted).length;
      const parts = [`已删除 ${deleted} 个远端分支`];
      if (failed > 0) parts.push(`失败 ${failed} 个`);
      setNotice(parts.join(" · "));
      clearSelection();
      setPending(null);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setPruneBusy(false);
      setPending(null);
    }
  }, [pending, groupByProject, clearSelection, refresh, setError, setNotice]);

  /** 切换仓库筛选时清掉上一次的结果面板（结果属于上一个仓库）。 */
  const resetPruneResults = useCallback(() => setPruneResults([]), []);

  return {
    pruneBusy,
    pruneResults,
    pending,
    startPrune,
    confirmPrune,
    resetPruneResults,
    cancelPrune: useCallback(() => setPending(null), []),
  };
}
