import type { DeliveryPlanStatus } from "../../types";
import type { IssueStatus } from "./deriveIssueStatus";

/** 计划 / 议题 / 方案的展示文案与 chip 色调（mockup delivery-plan-ui-v1 的语义映射）。
 *  独立模块：PlanPanel 与 PlanIssueRow 共用，避免互相 import 成环。 */

/** chip 色调（样式层 dpChip* 变体）：mockup 里 ok/warn/err/ac/中性 五档。 */
export type ChipTone = "neutral" | "ac" | "ok" | "warn" | "err";

export const PLAN_STATUS_LABEL: Record<DeliveryPlanStatus, string> = {
  active: "进行中",
  review: "待评审",
  merged: "已合并",
  closed: "已关闭",
};

/** 进行中=ac（mockup「进行中 chip ac」）；待评审=warn；已合并=ok；已关闭=中性。 */
export const PLAN_STATUS_TONE: Record<DeliveryPlanStatus, ChipTone> = {
  active: "ac",
  review: "warn",
  merged: "ok",
  closed: "neutral",
};

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  not_started: "未开始",
  discussing: "讨论中",
  discussed: "讨论完成",
  executing: "执行中",
  done: "已完成",
  aborted: "已结束",
};

/** mockup 汇总条：未开始=err、讨论中=warn、已完成=ok、已结束=中性；
 *  执行中（在途）=ac，讨论完成=中性。 */
export const ISSUE_STATUS_TONE: Record<IssueStatus, ChipTone> = {
  not_started: "err",
  discussing: "warn",
  discussed: "neutral",
  executing: "ac",
  done: "ok",
  aborted: "neutral",
};

export const SCHEME_STATUS_LABEL: Record<string, string> = {
  draft: "讨论中",
  finalized: "已定稿",
  executing: "执行中",
  completed: "已完成",
  cancelled: "已取消",
};
