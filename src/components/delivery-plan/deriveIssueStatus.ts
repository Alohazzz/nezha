import type { Plan, Task } from "../../types";

/** 计划详情里议题的派生状态（04 票：全自动派生，零手动维护）。
 *  aborted＝执行失败/取消且无在跑（可重新发起），不让失败任务伪装成进行中或已完成。 */
export type IssueStatus =
  | "not_started"
  | "discussing"
  | "discussed"
  | "executing"
  | "done"
  | "aborted";

/** 执行任务非终态（todo 是已建待办尚未启动，不算执行中）。 */
const EXEC_NON_TERMINAL = new Set([
  "pending",
  "running",
  "input_required",
  "awaiting_review",
  "waiting_deps",
  "detached",
  "interrupted",
]);

const SCHEME_DISCUSSED = new Set(["finalized", "executing", "completed"]);

/** 议题状态派生：信号源＝yunxiaoWorkitemId 匹配的任务 + issues 匹配的方案。
 *  从「已完成」往「未开始」取第一个命中——执行态天然覆盖讨论态。 */
export function deriveIssueStatus(
  workitemId: string,
  tasks: Task[],
  plans: Plan[],
): IssueStatus {
  const related = tasks.filter((t) => t.yunxiaoWorkitemId === workitemId);
  const execTasks = related.filter((t) => !t.yunxiaoPlanDiscussion);
  const discussionTasks = related.filter((t) => t.yunxiaoPlanDiscussion);
  const schemes = plans.filter((p) => p.issues.some((i) => i.workitemId === workitemId));

  if (execTasks.some((t) => t.status === "done")) return "done";
  if (execTasks.some((t) => EXEC_NON_TERMINAL.has(t.status))) return "executing";
  if (execTasks.some((t) => t.status === "failed" || t.status === "cancelled")) return "aborted";
  // 讨论完成＝方案已定稿（或在执行/已完成）；cancelled 方案展示但不计。
  if (schemes.some((p) => SCHEME_DISCUSSED.has(p.status))) return "discussed";
  if (discussionTasks.some((t) => EXEC_NON_TERMINAL.has(t.status))) return "discussing";
  if (schemes.some((p) => p.status === "draft")) return "discussing";
  return "not_started";
}
