import type { BranchBatch, Task } from "../../types";

export interface WorktreeScopeOption {
  key: string;
  label: string;
  /** 下拉里的路径详情；触发器仍展示 label，避免长路径撑宽右侧工具栏。 */
  description?: string;
}

/** 批次未记录 worktree 路径时，按旧版硬编码目录推导，保持历史批次可达。 */
export function batchWorktreePath(batch: BranchBatch, projectPath: string): string {
  return batch.worktreePath ?? `${projectPath}/.nezha/worktrees/${batch.id}`;
}

/** selector 只展示真实可进入的 worktree；失效批次留给 PR 面板清理，不静默改写记录。 */
export function buildWorktreeScopeOptions({
  tasks,
  batches,
  projectPath,
}: {
  tasks: Task[];
  batches: BranchBatch[];
  projectPath: string;
}): WorktreeScopeOption[] {
  const seen = new Set<string>();
  const options: WorktreeScopeOption[] = [{ key: "", label: "主检出" }];

  for (const task of tasks) {
    if (!task.worktreePath || task.worktreeDiscarded || seen.has(task.worktreePath)) continue;
    seen.add(task.worktreePath);
    options.push({
      key: task.worktreePath,
      label: `WorkTree · ${task.worktreeBranch ?? "?"}`,
      description: task.worktreePath,
    });
  }

  for (const batch of batches) {
    if (batch.status === "merged" || batch.status === "closed" || batch.worktreeMissing) continue;
    const key = batchWorktreePath(batch, projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: `WorkTree · ${batch.branch}`, description: key });
  }

  return options;
}
