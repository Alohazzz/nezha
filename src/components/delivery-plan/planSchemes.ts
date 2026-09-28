import type { Plan, Task } from "../../types";
import { buildPlanDisplayName } from "../../utils/plan";

/** draft 方案是否存活：仍有任务挂着 planId 指向它。
 *  发起讨论对话框「一打开就落 draft」，只有走取消路径才清理——崩溃 / 直接关窗 /
 *  讨论任务被删都会留下无主 draft。这种残留不是「讨论中」，是死数据。 */
export function isLivePlan(plan: Plan, tasks: Task[]): boolean {
  return plan.status !== "draft" || tasks.some((t) => t.planId === plan.id);
}

/** 计划议题表「关联方案」列的可见方案：覆盖该议题、非孤儿 draft。
 *  cancelled 保留展示（诚实呈现「讨论过但已取消」，与占用判定不冲突）。 */
export function visibleSchemesForIssue(
  workitemId: string,
  plans: Plan[],
  tasks: Task[],
): Plan[] {
  return plans.filter(
    (p) => p.issues.some((i) => i.workitemId === workitemId) && isLivePlan(p, tasks),
  );
}

/** 方案 chip 的展示名：name 为空时按议题快照拼（`QHDK-1` / `QHDK-1 等 3 项联合方案`），
 *  多议题方案不再伪装成单议题 chip 被当成重复。 */
export function schemeChipLabel(plan: Plan): string {
  return plan.name || buildPlanDisplayName(plan.issues.map((i) => i.serialNumber));
}

/** 方案下最新一条执行任务（可定位入口）；方案讨论任务不算——定位应直达干活的窗口。 */
export function latestSchemeExecTask(planId: string, tasks: Task[]): Task | undefined {
  return tasks
    .filter((t) => t.planId === planId && !t.yunxiaoPlanDiscussion)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

/** 关联方案列的单个 chip：方案 + 其可定位执行任务。 */
export interface SchemeChipData {
  plan: Plan;
  execTask?: Task;
}

/** 议题的关联方案 chip 数据：新方案在前（同议题多方案时最近的一次讨论优先看见）。 */
export function schemeChipsForIssue(
  workitemId: string,
  plans: Plan[],
  tasks: Task[],
): SchemeChipData[] {
  return visibleSchemesForIssue(workitemId, plans, tasks)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((plan) => ({ plan, execTask: latestSchemeExecTask(plan.id, tasks) }));
}
