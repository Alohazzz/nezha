import type { DeliveryPlan, Task } from "../../types";

/** 议题成员 → 交付计划（S10 强制绑定的查找口径）：
 *  单计划归属（S1）保证最多命中一个；已收尾计划（merged/closed）不再吸附新任务。 */
export function findDeliveryPlanForWorkitems(
  plans: DeliveryPlan[],
  workitemIds: Array<string | undefined | null>,
): DeliveryPlan | undefined {
  const ids = new Set(workitemIds.filter((w): w is string => !!w));
  if (ids.size === 0) return undefined;
  return plans.find(
    (p) =>
      (p.status === "active" || p.status === "review") &&
      p.issues.some((i) => ids.has(i.workitemId)),
  );
}

/** 计划内议题建任务时强制绑定（S3/S4/S10，不可改）：
 *  执行任务带出计划 worktree 字段（无 worktree 计划留空＝主检出语义，提交随主检出当前分支）；
 *  讨论任务只记归属、不进 worktree（项目根只读分析）。已绑定的不重复绑定。
 *  `workitemIds` 缺省取任务自身的 yunxiaoWorkitemId；多议题讨论任务由调用方显式传入。 */
export function bindTaskToDeliveryPlan(
  task: Task,
  plans: DeliveryPlan[],
  workitemIds?: Array<string | undefined | null>,
): Task {
  if (task.deliveryPlanId) return task;
  const ids = workitemIds ?? [task.yunxiaoWorkitemId];
  const plan = findDeliveryPlanForWorkitems(plans, ids);
  if (!plan) return task;
  if (task.yunxiaoPlanDiscussion) {
    return { ...task, deliveryPlanId: plan.id };
  }
  return {
    ...task,
    deliveryPlanId: plan.id,
    worktreePath: plan.useWorktree ? plan.worktreePath : undefined,
    worktreeBranch: plan.useWorktree ? plan.branch : undefined,
    baseBranch: plan.useWorktree ? plan.baseBranch : undefined,
    worktreeRepo: plan.useWorktree ? plan.worktreeRepo : undefined,
  };
}
