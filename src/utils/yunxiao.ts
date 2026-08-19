import type { Task, YunxiaoWorkitem } from "../types";

/** 云效 SearchWorkitems conditions 中单条过滤条件（conditionGroups 内同一组为 AND）。 */
export interface YunxiaoCondition {
  className: string;
  fieldIdentifier: string;
  format: string;
  operator: string;
  toValue: null;
  value: string[];
}

export interface YunxiaoConditionsInput {
  /** 标题搜索词（内部会 trim，空串不生成条件）。 */
  query?: string;
  /** 只看我负责的。 */
  assignedToMe?: boolean;
  /** 当前用户 ID（assignedToMe 且存在时才生成条件）。 */
  currentUserId?: string;
  /** 选中的状态 ID 列表（空数组不生成条件）。 */
  selectedStatusIds?: string[];
}

/**
 * 把标题搜索 + 我负责的 + 状态多选拼成云效 conditions JSON 字符串。
 * 无任何条件时返回 undefined（后端保持默认空条件）。所有条件放同一 conditionGroup（AND）。
 */
export function buildYunxiaoConditions(input: YunxiaoConditionsInput): string | undefined {
  const conditions: YunxiaoCondition[] = [];

  const query = input.query?.trim();
  if (query) {
    conditions.push({
      className: "string",
      fieldIdentifier: "subject",
      format: "input",
      operator: "CONTAINS",
      toValue: null,
      value: [query],
    });
  }

  const currentUserId = input.currentUserId?.trim();
  if (input.assignedToMe && currentUserId) {
    conditions.push({
      className: "user",
      fieldIdentifier: "assignedTo",
      format: "list",
      operator: "CONTAINS",
      toValue: null,
      value: [currentUserId],
    });
  }

  const statusIds = (input.selectedStatusIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (statusIds.length > 0) {
    conditions.push({
      className: "status",
      fieldIdentifier: "status",
      format: "list",
      operator: "CONTAINS",
      toValue: null,
      value: statusIds,
    });
  }

  if (conditions.length === 0) return undefined;
  return JSON.stringify({ conditionGroups: [conditions] });
}

/** 从自定义字段中提取优先级显示值（云效优先级字段 id 固定为 priority）。 */
export function getYunxiaoPriority(issue: YunxiaoWorkitem): string | undefined {
  const field = issue.customFieldValues.find((f) => f.fieldId === "priority");
  return field?.values[0]?.displayValue;
}

/** 议题 → 任务名：编号 + 标题。 */
export function buildYunxiaoTaskName(issue: YunxiaoWorkitem): string {
  return `${issue.serialNumber} ${issue.subject}`.trim();
}

/** 议题 → 任务提示词：标题、描述、状态、负责人、优先级与议题 id，作为 Agent 上下文。 */
export function buildYunxiaoPrompt(issue: YunxiaoWorkitem): string {
  const lines = [issue.subject];
  if (issue.description) {
    lines.push("", issue.description);
  }
  lines.push("", "---", `云效议题：${issue.serialNumber}`);
  lines.push(`状态：${issue.status?.displayName ?? issue.status?.name ?? "未知"}`);
  if (issue.assignedTo) {
    lines.push(`负责人：${issue.assignedTo.name}`);
  }
  const priority = getYunxiaoPriority(issue);
  if (priority) {
    lines.push(`优先级：${priority}`);
  }
  lines.push(`议题 ID：${issue.id}`);
  return lines.join("\n");
}

/** 去重判断：同议题只允许导入一次（以 yunxiaoWorkitemId 为键）。 */
export function isYunxiaoWorkitemImported(tasks: Task[], workitemId: string): boolean {
  if (!workitemId) return false;
  return tasks.some((task) => task.yunxiaoWorkitemId === workitemId);
}
