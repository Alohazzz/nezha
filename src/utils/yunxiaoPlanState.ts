/**
 * 议题列表「按议题 ID 反查方案状态」的共享派生（议题列表 / 待办双入口共用）。
 *
 * 议题与本地方案的关联键是 `PlanIssue.workitemId`（方案快照内含议题 ID 与编号，
 * 数据模型无需迁移）。一个议题理论上可同时出现在多个方案快照里（父/子方案链、
 * 竞态），展示口径取「活跃方案里最近创建」的一个——旧方案要么已 cancelled、要么
 * 已被更新链路取代，最近创建的那个才是用户心智里的「当前方案」。
 *
 * 状态机（badge 与行内动作的唯一定义处，UI 只读不判）：
 * - discussing      讨论中：讨论任务存活且未挂起（pending/running/detached/awaiting_review）
 * - awaiting_input  需要回答：讨论任务 input_required（agent 在等用户回答）
 * - discussion_broken 讨论未完成：讨论任务 failed/cancelled/interrupted，或 discussionTaskId 悬空
 * - finalized       已定稿：讨论定稿、尚未生成待办（方案维度从行内动作启动执行）
 * - executing       执行中：方案待办存在（含 todo/waiting_deps——「执行方案」变「继续执行」）
 * - completed       已完成：方案标记完成（含讨论定稿前取消的兜底归属）
 * - direct_task     直接执行占用：无方案、但有任务直接绑定该议题（原「已导入」态）
 * - none            无方案无任务：行内维持原三按钮
 */
import type { Plan, Task } from "../types";

/** 议题相对方案的状态（badge 文案与色调、行内动作都按它分支）。 */
export type YunxiaoIssuePlanState =
  | "none"
  | "discussing"
  | "awaiting_input"
  | "discussion_broken"
  | "finalized"
  | "executing"
  | "completed"
  | "direct_task";

/** 议题行可执行的动作（行内按钮由此集合派生，避免各处散落状态判断）。 */
export interface YunxiaoIssuePlanActions {
  /** 打开查看方案弹窗（方案存在即可）。 */
  view: boolean;
  /** 跳到讨论任务终端（需要回答 / 讨论中）。 */
  openTask: boolean;
  /** 继续讨论（resume 失败/取消的讨论任务）。 */
  resumeDiscussion: boolean;
  /** 执行整个方案（finalized 且 plan.md 未生成过待办）。 */
  startPlan: boolean;
  /** 继续执行（executing：已有待办，不再重新生成）。 */
  continuePlan: boolean;
  /** 删除重议（级联取消讨论任务 + 删方案 + 自动发起新讨论）。 */
  rediscuss: boolean;
  /** 取消方案（executing 的逃生通道：取消后议题回到无方案态）。 */
  cancelPlan: boolean;
  /** 查看承载议题的执行/讨论任务（跳任务视图）。 */
  locateTask: boolean;
}

/** 反查结果：状态 + 方案 + 承载任务。方案不存在时 plan/task 为 null。 */
export interface YunxiaoIssuePlanInfo {
  state: YunxiaoIssuePlanState;
  /** 关联的活跃方案（最近创建）；direct_task / none 为 null。 */
  plan: Plan | null;
  /** state 对应的承载任务：讨论态是讨论任务，direct_task 是直接执行任务，其余 null。 */
  task: Task | null;
  actions: YunxiaoIssuePlanActions;
}

const EMPTY_ACTIONS: YunxiaoIssuePlanActions = {
  view: false,
  openTask: false,
  resumeDiscussion: false,
  startPlan: false,
  continuePlan: false,
  rediscuss: false,
  cancelPlan: false,
  locateTask: false,
};

/** 讨论任务「已断掉」（可继续讨论 / 删除重议）。 */
function isDiscussionBroken(status: Task["status"]): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

/** 任务列表里讨论任务（yunxiaoPlanDiscussion 且挂 planId）按 planId 索引。 */
function discussionTaskByPlanId(tasks: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    if (task.yunxiaoPlanDiscussion && task.planId) map.set(task.planId, task);
  }
  return map;
}

/**
 * 议题 → 方案状态（单个议题查询版）。
 *
 * 反查范围是**所有非 cancelled 方案**（含孤儿方案——讨论任务被删后方案记录与
 * plan.md 仍在，议题行应继续展示「查看方案 / 执行方案 / 删除重议 / 取消方案」，
 * 这些动作本身就是出口，孤儿方案不再是无路可走的死状态；旧「孤儿不占用」口径
 * 只保留在 `collectOccupiedYunxiaoWorkitemIds`（多选导入去重）里）。同议题命中
 * 多个方案时取最近创建——旧方案要么已 cancelled、要么已被更新链路取代。
 */
export function getIssuePlanInfo(
  workitemId: string,
  tasks: readonly Task[],
  plans: readonly Plan[],
): YunxiaoIssuePlanInfo {
  if (!workitemId) return { state: "none", plan: null, task: null, actions: EMPTY_ACTIONS };

  // 活跃方案：非 cancelled、包含该议题。同议题命中多个时取最近创建。
  let plan: Plan | null = null;
  for (const candidate of plans) {
    if (candidate.status === "cancelled") continue;
    if (!candidate.issues.some((issue) => issue.workitemId === workitemId)) continue;
    if (!plan || candidate.createdAt > plan.createdAt) plan = candidate;
  }

  if (!plan) {
    // 无方案：看是否有任务直接绑定（直接执行任务 / 补录待办等）。
    const bound = [...tasks]
      .reverse()
      .find((task) => task.yunxiaoWorkitemId === workitemId);
    if (bound) {
      return {
        state: "direct_task",
        plan: null,
        task: bound,
        actions: { ...EMPTY_ACTIONS, locateTask: true },
      };
    }
    return { state: "none", plan: null, task: null, actions: EMPTY_ACTIONS };
  }

  const discussion = discussionTaskByPlanId(tasks).get(plan.id) ?? null;
  const info: YunxiaoIssuePlanInfo = { state: "none", plan, task: discussion, actions: { ...EMPTY_ACTIONS, view: true } };

  if (plan.status === "draft") {
    if (!discussion || isDiscussionBroken(discussion.status)) {
      // 讨论任务断掉或 discussionTaskId 悬空：可续聊或删除重议。
      info.state = "discussion_broken";
      info.actions.resumeDiscussion = !!discussion;
      info.actions.rediscuss = true;
      info.actions.cancelPlan = true;
    } else if (discussion.status === "input_required") {
      info.state = "awaiting_input";
      info.actions.openTask = true;
      info.actions.rediscuss = true;
    } else {
      info.state = "discussing";
      info.actions.openTask = true;
      info.actions.rediscuss = true;
    }
    return info;
  }

  if (plan.status === "finalized") {
    info.state = "finalized";
    info.actions.startPlan = true;
    info.actions.rediscuss = true;
    info.actions.cancelPlan = true;
    return info;
  }

  if (plan.status === "executing") {
    info.state = "executing";
    // 已生成过待办：动作是「继续执行」（去方案预览补齐缺口/重跑），不在这里重复生成。
    info.actions.continuePlan = true;
    info.actions.cancelPlan = true;
    return info;
  }

  // completed
  info.state = "completed";
  return info;
}

/** 批量版：议题列表一次派生整个 Map，避免每行各算一遍。 */
export function buildIssuePlanInfoMap(
  issues: readonly { id: string }[],
  tasks: readonly Task[],
  plans: readonly Plan[],
): Map<string, YunxiaoIssuePlanInfo> {
  const map = new Map<string, YunxiaoIssuePlanInfo>();
  for (const issue of issues) {
    map.set(issue.id, getIssuePlanInfo(issue.id, tasks, plans));
  }
  return map;
}
