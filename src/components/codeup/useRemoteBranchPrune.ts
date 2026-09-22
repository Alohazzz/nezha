import { useCallback, useRef, useState } from "react";
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
 * **乐观秒开**：dry-run 门禁要跑好几秒（云效 API + live ls-remote + 两次 fetch），
 * 点击删除时立刻用所选分支打开确认框（`pruneChecking` 置位、确认按钮显示「检查删除条件…」），
 * 门禁通过才把 `pending` 收敛为可通过子集并点亮确认按钮；全军覆没则关框出通知。
 * 确认框内的取消会作废在途 dry-run（run-id 守卫），迟到结果不得重开弹层。
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
  const [pruneChecking, setPruneChecking] = useState(false);
  const [pruneResults, setPruneResults] = useState<PendingRemoteBranchPruneItem[]>([]);
  const [pending, setPending] = useState<PendingRemoteBranchTarget[] | null>(null);
  /** 每次开始检查 / 取消时自增；在途 dry-run 回来后对不上号就作废。 */
  const runIdRef = useRef(0);

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

  /**
   * 第一步：dry-run 扫描，不做任何写操作。
   *
   * `items` 缺省时用勾选集（头部批量删除）；行内「删除」按钮显式传自己这一行——曾因
   * 复用勾选集导致未勾选时静默 return（点了毫无反应），勾了别的行时删错对象。
   */
  const startPrune = useCallback(async (items?: PendingBranchCandidate[]) => {
    const targets = items ?? selectedDeletable;
    if (targets.length === 0) return;
    setError("");
    setNotice("");
    const runId = ++runIdRef.current;
    // 乐观打开：点完立刻给确认框，门禁在框内继续跑——不再让用户对着列表干等十秒。
    setPending(targets.map(toPruneTarget));
    setPruneChecking(true);
    try {
      const collect: PendingRemoteBranchPruneItem[] = [];
      for (const [projectPath, branches] of groupByProject(targets)) {
        const result = await invoke<PendingRemoteBranchPruneItem[]>("prune_remote_branches", {
          projectPath,
          items: branches.map(toPruneTarget),
          dryRun: true,
        });
        collect.push(...result);
      }
      if (runId !== runIdRef.current) return; // 已取消 / 被新一轮取代
      const deletable = collect.filter((item) => item.deletable);
      if (deletable.length === 0) {
        // 没有任何一条通过门禁：关掉乐观弹层，把逐条原因摊开给用户看。
        setPending(null);
        setPruneResults(collect);
        // 全部因「远端已无该分支」跳过是**达成**而非拒绝——删除的目标状态已经成立，
        // 沿用「均不满足删除条件」会让用户以为点了没有任何反应。
        const allGone =
          collect.length > 0 &&
          collect.every((item) => item.reason.includes("远端已无该分支"));
        setNotice(
          allGone
            ? "所选分支在远端已不存在，删除目标已达成，无需删除。"
            : "所选分支均不满足删除条件，未执行删除。",
        );
        return;
      }
      // 有可删项时不写结果面板——此时断言「删除失败」是错的，用户还没确认。
      // 弹层内容从「乐观所选」收敛为「通过门禁的子集」，确认按钮计数随之更新。
      setPending(deletable.map(({ repoPath, repo, branch, targetBranch }) => ({
        repoPath,
        repo,
        branch,
        targetBranch,
      })));
    } catch (e) {
      if (runId === runIdRef.current) {
        setPending(null);
        setError(String(e));
      }
    } finally {
      if (runId === runIdRef.current) setPruneChecking(false);
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
      // 幂等达成（deleted=true 且原因带「目标已达成」）计入 deleted——用户要的结果
      // 「远端无此分支」已成立，归入失败会让成功操作显示成红色。
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
    pruneChecking,
    pruneResults,
    pending,
    startPrune,
    confirmPrune,
    resetPruneResults,
    cancelPrune: useCallback(() => {
      // 作废在途 dry-run：取消后迟到的门禁结果不得把弹层重新打开。
      runIdRef.current += 1;
      setPruneChecking(false);
      setPending(null);
    }, []),
  };
}
