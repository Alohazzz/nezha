import type { AgentType, PermissionMode, Task, YunxiaoWorkitem } from "../types";

const YUNXIAO_LAST_AGENT_PREFIX = "nezha:lastYunxiaoAgent:";
const YUNXIAO_LAST_PERMISSION_PREFIX = "nezha:lastYunxiaoPermission:";
const YUNXIAO_WORKITEM_BASE = "https://devops.aliyun.com/projex";

/**
 * 云效 Projex 工作项详情页链接。
 * URL 格式与 v1 项目链接同源（…/projex/project/{projectId}/…）；
 * 实现时以浏览器真实地址复验，如格式有出入只改这里。
 */
export function buildYunxiaoIssueLink(projectId: string, workitemId: string): string {
  const project = projectId.trim();
  const workitem = workitemId.trim();
  if (!project || !workitem) return "";
  return `${YUNXIAO_WORKITEM_BASE}/project/${project}/workitem/${workitem}`;
}

/** 读取某项目上次选择的云效 Agent（无记忆或值非法时返回 null）。 */
export function getLastYunxiaoAgent(projectId: string): AgentType | null {
  try {
    const value = localStorage.getItem(`${YUNXIAO_LAST_AGENT_PREFIX}${projectId}`);
    return value === "claude" || value === "codex" || value === "dsh" ? value : null;
  } catch {
    return null;
  }
}

/** 记录某项目选择的云效 Agent（localStorage 不可用时静默降级）。 */
export function setLastYunxiaoAgent(projectId: string, agent: AgentType): void {
  try {
    localStorage.setItem(`${YUNXIAO_LAST_AGENT_PREFIX}${projectId}`, agent);
  } catch {
    // localStorage 不可用（受限 webview 等）时不阻断流程
  }
}

/** 读取某项目上次选择的云效权限模式（无记忆或值非法时返回 null）。 */
export function getLastYunxiaoPermission(projectId: string): PermissionMode | null {
  try {
    const value = localStorage.getItem(`${YUNXIAO_LAST_PERMISSION_PREFIX}${projectId}`);
    return value === "ask" || value === "auto_edit" || value === "full_access" ? value : null;
  } catch {
    return null;
  }
}

/** 记录某项目选择的云效权限模式（localStorage 不可用时静默降级）。 */
export function setLastYunxiaoPermission(projectId: string, mode: PermissionMode): void {
  try {
    localStorage.setItem(`${YUNXIAO_LAST_PERMISSION_PREFIX}${projectId}`, mode);
  } catch {
    // localStorage 不可用（受限 webview 等）时不阻断流程
  }
}

/**
 * 云效议题描述 → 可读纯文本（与后端 normalize_issue_description 逻辑一致，双保险）：
 * 富文本 JSON（TipTap/Notion 风格）按段落提取文本；HTML 标签与实体剥离；其余原样返回。
 */
export function normalizeIssueDescription(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const text = extractRichText(parsed);
      if (text.trim()) return text.trim();
    } catch {
      // 不是 JSON，落到 HTML 剥离
    }
  }
  return stripHtmlTags(trimmed).trim();
}

function extractRichText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const lines = value
      .map(extractRichText)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return lines.join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["text", "content", "value"]) {
      if (key in obj) {
        const text = extractRichText(obj[key]).trim();
        if (text) return text;
      }
    }
    const parts = Object.values(obj)
      .map(extractRichText)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return parts.join(" ");
  }
  return "";
}

function stripHtmlTags(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n");
}

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

/** 议题编号 → Git 提交关联 tag（如 QHDK-29312 → "#QHDK-29312"）。 */
export function issueTag(serialNumber: string): string {
  const serial = serialNumber.trim();
  if (!serial) return "";
  return serial.startsWith("#") ? serial : `#${serial}`;
}

/** 提交信息是否已包含议题 tag（大小写不敏感）。 */
export function messageHasIssueTag(message: string, serialNumber: string): boolean {
  const tag = issueTag(serialNumber);
  if (!tag) return true;
  return message.toLowerCase().includes(tag.toLowerCase());
}

/** 提交信息缺 tag 时追加（后端 git_commit 也会兜底，这里给 UI 预览用）。 */
export function ensureIssueTagInMessage(message: string, serialNumber: string): string {
  const tag = issueTag(serialNumber);
  if (!tag || messageHasIssueTag(message, serialNumber)) return message;
  return `${message.trimEnd()}\n\n${tag}`;
}
