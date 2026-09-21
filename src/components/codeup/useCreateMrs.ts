import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  PendingBranchCandidate,
  PendingMrCreateItem,
  PendingMrCreateReceipt,
} from "../../types";

/** 扫描结果里带的项目根（发起时按 project_path 做仓库路径边界校验）。 */
interface ScopedScan {
  path: string;
  projectPath: string;
}

/**
 * 批量「发起合并请求」的流程状态机（选好行 → 确认弹层 → 逐条回执）。
 *
 * 与删除远端分支同构，但**没有 dry-run**：发起 MR 本身是幂等的（同源 + 同目标已有开放 MR
 * 会被后端跳过），不需要先扫一遍再确认；弹层里列清「哪些分支 → 哪个目标分支」供用户核对，
 * 确认后逐条创建、单条失败不中断。
 *
 * 后端按 `project_path` 校验仓库路径，故请求要**按项目分组**发送。
 *
 * 审核人以**人名**贯穿前后端：保护规则预填、成员选择器勾选、用户手填都是人名，
 * 后端发起时统一解析成云效 userID（重名 / 查无此人会逐条报错，不静默丢弃）。
 */
export function useCreateMrs({
  scans,
  selectedCandidates,
  refresh,
  clearSelection,
  setError,
  setNotice,
}: {
  scans: ScopedScan[];
  /** 当前已选中且适合发起 MR 的分支。 */
  selectedCandidates: PendingBranchCandidate[];
  /** 创建完成后重跑扫描（新 MR 会以「已有 MR」徽标出现）。 */
  refresh: () => void;
  clearSelection: () => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}) {
  const [createBusy, setCreateBusy] = useState(false);
  const [createResults, setCreateResults] = useState<PendingMrCreateReceipt[]>([]);
  /** 待确认项；`null` 表示弹层关闭。 */
  const [pending, setPending] = useState<PendingBranchCandidate[] | null>(null);
  /** 已选审核人（人名列表）。 */
  const [reviewers, setReviewers] = useState<string[]>([]);
  /** 目标分支保护规则里的默认审核人，在成员选择器里置顶并标「推荐」。 */
  const [recommendedReviewers, setRecommendedReviewers] = useState<string[]>([]);

  /** 按项目根分组——后端以 project_path 为边界校验仓库路径。 */
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

  /** 打开确认弹层，并按目标分支保护规则预填审核人（不同目标分支的评审人取并集）。 */
  const startCreate = useCallback(async () => {
    if (selectedCandidates.length === 0) return;
    setError("");
    setNotice("");
    setPending(selectedCandidates);

    // 目标分支 → 该分支的默认评审人。按 (仓库, 目标分支) 去重，避免同一目标重复请求。
    const targets = new Map<string, { projectPath: string; repoPath: string; target: string }>();
    for (const branch of selectedCandidates) {
      const projectPath = scans.find((scan) => scan.path === branch.repoPath)?.projectPath ?? "";
      targets.set(`${branch.repoPath}\u0000${branch.targetBranch}`, {
        projectPath,
        repoPath: branch.repoPath,
        target: branch.targetBranch,
      });
    }
    const names: string[] = [];
    for (const { projectPath, repoPath, target } of targets.values()) {
      if (!target.trim()) continue;
      try {
        const managers = await invoke<string[]>("codeup_branch_managers", {
          projectPath,
          repoPath,
          targetBranch: target,
        });
        for (const name of managers) {
          if (!names.includes(name)) names.push(name);
        }
      } catch (e) {
        // 默认评审人是可选信息：拉不到就让用户自己选/填，不阻断发起流程。
        console.warn("[create-mrs] load branch reviewers failed:", e);
      }
    }
    setRecommendedReviewers(names);
    setReviewers(names);
  }, [selectedCandidates, scans, setError, setNotice]);

  /** 用户确认后才真发起。单条失败不中断整批（后端逐条返回回执）。 */
  const confirmCreate = useCallback(async () => {
    const targets = pending ?? [];
    if (targets.length === 0) return;
    setCreateBusy(true);
    try {
      const done: PendingMrCreateReceipt[] = [];
      for (const [projectPath, branches] of groupByProject(targets)) {
        const items: PendingMrCreateItem[] = branches.map((branch) => ({
          repoPath: branch.repoPath,
          repo: branch.repo,
          sourceBranch: branch.branch,
          targetBranch: branch.targetBranch,
          reviewers,
        }));
        const result = await invoke<PendingMrCreateReceipt[]>("codeup_create_mrs_batch", {
          projectPath,
          items,
        });
        done.push(...result);
      }
      setCreateResults(done);
      const created = done.filter((item) => item.created).length;
      const failed = done.filter((item) => !item.created).length;
      const parts = [`已发起 ${created} 个合并请求`];
      if (failed > 0) parts.push(`跳过/失败 ${failed} 个`);
      setNotice(parts.join(" · "));
      clearSelection();
      setPending(null);
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreateBusy(false);
      setPending(null);
    }
  }, [pending, reviewers, groupByProject, clearSelection, refresh, setError, setNotice]);

  /** 切换仓库筛选时清掉上一次的结果面板（结果属于上一个仓库）。 */
  const resetCreateResults = useCallback(() => setCreateResults([]), []);

  return {
    createBusy,
    createResults,
    pending,
    reviewers,
    recommendedReviewers,
    setReviewers,
    startCreate,
    confirmCreate,
    resetCreateResults,
    cancelCreate: useCallback(() => setPending(null), []),
  };
}
