import type { DeliveryPlan, Project, Task } from "../../types";

export interface WorktreeScopeOption {
  key: string;
  label: string;
  /** 下拉里的路径详情；触发器仍展示 label，避免长路径撑宽右侧工具栏。 */
  description?: string;
}

/** 批次未记录 worktree 路径时，按旧版硬编码目录推导，保持历史批次可达。 */
export function batchWorktreePath(batch: DeliveryPlan, projectPath: string): string {
  return batch.worktreePath ?? `${projectPath}/.nezha/worktrees/${batch.id}`;
}

/** 批归属的作用域：另建 worktree 的批归到 worktree 路径，否则归到主检出（空 key）。 */
export function batchScopeKey(batch: DeliveryPlan, projectPath: string): string {
  return batch.useWorktree === false ? "" : batchWorktreePath(batch, projectPath);
}

/** selector 只展示真实可进入的 worktree；失效批次留给 PR 面板清理，不静默改写记录。
 *  选中任务带跨仓库上下文（contextProjectIds）时，附加项目作为额外作用域并列，
 *  让 Git 变更 / 历史面板可以直接切到该仓库处置任务产生的变更。 */
export function buildWorktreeScopeOptions({
  tasks,
  batches,
  projectPath,
  selectedTask,
  projects = [],
}: {
  tasks: Task[];
  batches: DeliveryPlan[];
  projectPath: string;
  /** 当前选中任务：其 contextProjectIds 决定列出哪些附加项目仓库。 */
  selectedTask?: Task | null;
  /** 全部项目列表，用于把附加项目 id 解析为名称/路径。 */
  projects?: Project[];
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
    // 不另建 worktree 的批住在主检出里，不产生新的作用域选项。
    if (batch.useWorktree === false) continue;
    if (batch.status === "merged" || batch.status === "closed" || batch.worktreeMissing) continue;
    const key = batchWorktreePath(batch, projectPath);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, label: `WorkTree · ${batch.branch}`, description: key });
  }

  const contextIds = selectedTask?.contextProjectIds ?? [];
  for (const id of contextIds) {
    const ctxProject = projects.find((p) => p.id === id);
    if (!ctxProject || seen.has(ctxProject.path)) continue;
    seen.add(ctxProject.path);
    options.push({
      key: ctxProject.path,
      label: `Repo · ${ctxProject.name}`,
      description: ctxProject.path,
    });
  }

  return options;
}
