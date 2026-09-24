import type { DeliveryPlan } from "../../types";

export interface PlanBranchDrift {
  /** 主检出当前实际所在的分支（游离 HEAD 时为空串）。 */
  currentBranch: string;
  /** 计划登记的分支。 */
  expectedBranch: string;
}

/** 该计划是否「分支落在主检出里」——只有这类计划需要启动前校验当前分支。
 *  启用 worktree 的批由 worktree 路径钉死分支；计划已收尾时分支可能已被清理，都不校验。 */
export function planNeedsBranchCheckout(plan: DeliveryPlan | undefined | null): boolean {
  if (!plan) return false;
  if (plan.useWorktree === true) return false;
  if (plan.status !== "active" && plan.status !== "review") return false;
  return plan.branch.trim().length > 0;
}

/** 主检出分支与计划分支是否漂移。返回 null 表示放行（不需要校验 / 已一致 / 信息不足）。 */
export function planBranchDrift(
  plan: DeliveryPlan | undefined | null,
  currentBranch: string,
): PlanBranchDrift | null {
  if (!planNeedsBranchCheckout(plan)) return null;
  const expectedBranch = plan!.branch.trim();
  const observed = currentBranch.trim();
  if (observed === expectedBranch) return null;
  return { currentBranch: observed, expectedBranch };
}
