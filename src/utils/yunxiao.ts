import type { Task, YunxiaoWorkitem } from "../types";

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