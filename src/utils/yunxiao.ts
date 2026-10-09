import type {
  AgentType,
  PermissionMode,
  Plan,
  PlanIssue,
  Task,
  YunxiaoWorkitem,
} from "../types";

const YUNXIAO_LAST_AGENT_PREFIX = "nezha:lastYunxiaoAgent:";
const YUNXIAO_LAST_PERMISSION_PREFIX = "nezha:lastYunxiaoPermission:";
const YUNXIAO_WORKITEM_BASE = "https://devops.aliyun.com/projex";
const VALUE_SCORE_SECTION_HEADER = "## 价值评分";

/** 知识沉淀审核议题的目标项目（云效「知识库图谱」项目；可在 YunxiaoSettings.knowledgeBaseProjectId 覆盖）。 */
export const YUNXIAO_KNOWLEDGE_BASE_PROJECT_ID = "bc826ccda665f0718511440fac";

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

/**
 * 计划成员快照（PlanIssue）→ 讨论链路需要的云效议题壳。
 *
 * 计划详情里的行只有快照字段，而发起讨论的入口（`PlanLaunchDialog`）要的是
 * `YunxiaoWorkitem`：它只用 id/编号/标题/类别做展示与方案快照，详情正文与图片
 * 打开弹窗后再现拉（`yunxiao_get_workitem` / `yunxiao_prepare_issue_images`），
 * 所以这里不必伪造 description / customFieldValues。
 */
export function planIssueToWorkitem(issue: PlanIssue): YunxiaoWorkitem {
  return {
    id: issue.workitemId,
    serialNumber: issue.serialNumber,
    subject: issue.subject,
    categoryId: issue.category,
    customFieldValues: [],
  };
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
 * 内联图片数据（`data:…;base64,…`）不是正文——图片已由后端下载到方案目录并按路径注入
 * 讨论 prompt；不剥离会把 prompt 撑到 16 万字符级，撞 Windows 命令行 32,767 上限。
 */
export function normalizeIssueDescription(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // 不是 JSON，落到下面的 HTML 剥离
      return stripInlineImageData(stripHtmlTags(trimmed)).trim();
    }
    // JSON 解析成功即信任结构化提取。正文可能为空（纯图片描述——图片已按路径注入 prompt），
    // 此时**不能**回退成原文：否则 `{htmlValue, jsonMLValue}` 会原样进 prompt（回归 QHDK-30368）。
    return extractRichText(parsed).trim();
  }
  return stripInlineImageData(stripHtmlTags(trimmed)).trim();
}

/** 内联图片数据（`data:image/…`、`data:…;base64,…`）替换为占位，避免把图片字节当正文。 */
function stripInlineImageData(input: string): string {
  if (!input.includes("data:")) return input;
  return input
    .replace(/data:[^\s"')\]}]*;base64,[^\s"')\]}]*/g, "[图片]")
    .replace(/data:image\/[^\s"')\]}]*/g, "[图片]");
}

/** jsonML 块/行节点：`[标签名, 属性对象, …子节点]`。用于把它与普通数组区分开。 */
function looksLikeJsonML(items: unknown[]): boolean {
  return (
    items.length >= 2 &&
    typeof items[0] === "string" &&
    items[1] !== null &&
    typeof items[1] === "object" &&
    !Array.isArray(items[1])
  );
}

/**
 * jsonML 富文本树（`["root",{},["p",{},["span",{…},TEXT]]]`）的内容文本：
 * 第 0 位是标签名、第 1 位（对象）是属性，都不是正文，只递归第 2 位起的子节点。
 * 直接扁平化整棵树会把节点名（root/p/span/leaf）与 img 的 data URI 当正文。
 */
function jsonMLContentText(node: unknown[]): string {
  const lines: string[] = [];
  for (const child of node.slice(2)) {
    if (typeof child === "string") {
      const text = stripInlineImageData(child).trim();
      if (text) lines.push(text);
    } else {
      const text = extractRichText(child).trim();
      if (text) lines.push(text);
    }
  }
  return lines.join("\n");
}

function extractRichText(value: unknown): string {
  if (typeof value === "string") return stripInlineImageData(value);
  if (Array.isArray(value)) {
    if (looksLikeJsonML(value)) return jsonMLContentText(value);
    const lines = value
      .map(extractRichText)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return lines.join("\n");
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // 云效 RICHTEXT 描述是 {htmlValue, jsonMLValue}：htmlValue 是阅读态 HTML（正文文本 + 图片
    // 标签），jsonMLValue 是结构化树。优先取 htmlValue——两者都扁平化会把 jsonML 的节点名与
    // 内联 base64 当正文（回归 QHDK-30368）。
    if (typeof obj.htmlValue === "string") {
      const text = stripInlineImageData(stripHtmlTags(obj.htmlValue)).trim();
      if (text) return text;
    }
    if (obj.jsonMLValue !== undefined) {
      const text = extractRichText(obj.jsonMLValue).trim();
      if (text) return text;
    }
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
  /** 选中的版本 ID 列表（空数组不生成条件）。 */
  selectedVersionIds?: string[];
  /** 选中的产品名列表（本地过滤用，不进 conditions——实测服务端不支持按文本过滤自定义字段）。 */
  selectedProducts?: string[];
  /** 计划完成时间范围（毫秒时间戳；自定义字段条件需字段 ID）。 */
  planEndDateRange?: { from?: number; to?: number };
  /** 「计划完成时间」自定义字段 ID（时间范围条件依赖它，缺省不生成条件）。 */
  planEndFieldId?: string;
}

/** 议题编号 token（如 QHDK-30074 / ABC-12：字母前缀-数字）。 */
const ISSUE_SERIAL_TOKEN = /\b[A-Za-z][A-Za-z0-9]*-\d+\b/g;

/**
 * 把标题搜索 + 我负责的 + 状态多选拼成云效 conditions JSON 字符串。
 * 无任何条件时返回 undefined（后端保持默认空条件）。所有条件放同一 conditionGroup（AND）。
 *
 * 编号搜索：query 为单个议题编号（字母前缀-数字，如 QHDK-30074）时改走
 * serialNumber 条件（实测有效；标题 CONTAINS 匹配不到编号）。混合输入
 * （编号 + 其他词）仍走标题搜索；多编号 AND 语义不可靠，不支持。
 */
export function buildYunxiaoConditions(input: YunxiaoConditionsInput): string | undefined {
  const conditions: YunxiaoCondition[] = [];

  const query = input.query?.trim();
  if (query) {
    const serialMatch = query.match(ISSUE_SERIAL_TOKEN);
    const isSingleSerial =
      serialMatch !== null && serialMatch.length === 1 && serialMatch[0] === query;
    if (isSingleSerial) {
      conditions.push({
        className: "string",
        fieldIdentifier: "serialNumber",
        format: "input",
        operator: "CONTAINS",
        toValue: null,
        value: [query.toUpperCase()],
      });
    } else {
      conditions.push({
        className: "string",
        fieldIdentifier: "subject",
        format: "input",
        operator: "CONTAINS",
        toValue: null,
        value: [query],
      });
    }
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

  // 版本过滤：fieldIdentifier 是单数 version（复数 versions 实测返回 0 条）；
  // 多值为 OR 语义（实测有效），与其他条件 AND。
  const versionIds = (input.selectedVersionIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (versionIds.length > 0) {
    conditions.push({
      className: "version",
      fieldIdentifier: "version",
      format: "list",
      operator: "CONTAINS",
      toValue: null,
      value: versionIds,
    });
  }

  // 产品过滤不做服务端 conditions：实测差分（2026-10）云效 SearchWorkitems 对
  // 自定义字段按显示文本过滤整体不可用——CONTAINS 返回恒 0，IN/= 不过滤返回全量，
  // 对照组（来源字段）同样 0 条。产品改为前端本地过滤（YunxiaoView），此处跳过。

  // 计划完成时间范围（自定义字段）：fieldIdentifier 用字段 ID，BETWEEN 闭区间；
  // 只填起或止时退化为 GTE / LTE。字段 ID 未知时不生成条件。
  const range = input.planEndDateRange;
  const fieldId = input.planEndFieldId?.trim();
  if (range && fieldId) {
    const from = typeof range.from === "number" ? Math.floor(range.from) : undefined;
    const to = typeof range.to === "number" ? Math.floor(range.to) : undefined;
    if (from !== undefined && to !== undefined) {
      conditions.push({
        className: "date",
        fieldIdentifier: fieldId,
        format: "input",
        operator: "BETWEEN",
        toValue: null,
        value: [String(from), String(to)],
      });
    } else if (from !== undefined || to !== undefined) {
      conditions.push({
        className: "date",
        fieldIdentifier: fieldId,
        format: "input",
        operator: from !== undefined ? "GTE" : "LTE",
        toValue: null,
        value: [String(from ?? to)],
      });
    }
  }

  if (conditions.length === 0) return undefined;
  return JSON.stringify({ conditionGroups: [conditions] });
}

/** 从自定义字段中提取优先级显示值（云效优先级字段 id 固定为 priority）。 */
export function getYunxiaoPriority(issue: YunxiaoWorkitem): string | undefined {
  const field = issue.customFieldValues.find((f) => f.fieldId === "priority");
  return field?.values[0]?.displayValue;
}

/** 「计划完成时间」自定义字段的项目级约定名称（yunxiao_find_custom_field_id 按它查 ID）。 */
export const YUNXIAO_PLAN_END_FIELD_NAME = "计划完成时间";

/** 「所属产品」自定义字段的项目级约定名称（同上）。 */
export const YUNXIAO_PRODUCT_FIELD_NAME = "所属产品";

/**
 * 从议题自定义字段里提取「所属产品」显示名（顶层 product 键实测不存在，
 * 产品值在 customFieldValues，fieldId 按项目字段配置探测）。
 */
export function getYunxiaoProduct(
  issue: YunxiaoWorkitem,
  productFieldId?: string,
): string | undefined {
  if (issue.product) return issue.product;
  const field = productFieldId
    ? issue.customFieldValues.find((f) => f.fieldId === productFieldId)
    : undefined;
  return field?.values[0]?.displayValue || undefined;
}

/** 计划完成时间快捷范围：本周（周一起始自然周）/ 本月（自然月）。 */
export function getYunxiaoPresetRange(
  preset: "week" | "month",
  now: Date = new Date(),
): { from: number; to: number } {
  if (preset === "week") {
    const from = new Date(now);
    // 周一起始：周日(getDay=0)回退到上周一（-6 天），其余减 getDay()-1 天
    from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 7);
    return { from: from.getTime(), to: to.getTime() - 1 };
  }
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { from: from.getTime(), to: to.getTime() - 1 };
}

/** 解析云效自定义字段的日期文本（yyyy/mm/dd、yyyy.mm.dd、yyyy-mm-dd）为本地时区当天 00:00。
 *  不用 Date.parse：纯日期 ISO 串按 UTC 解析，UTC+8 下得到当天 08:00，逾期判断会漂移 8 小时。 */
function parseLocalDateString(raw: string): number | undefined {
  const m = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return undefined;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 从议题自定义字段里提取「计划完成时间」（毫秒时间戳）。
 * 云效自定义字段值形态不统一：displayValue 可能是 "2026/10/15" 或时间戳字符串，
 * 能解析成日期/数字才返回。Workitem.planEndDate（后端直出的标准字段）优先。
 */
export function getYunxiaoPlanEndDate(
  issue: YunxiaoWorkitem,
  planEndFieldId?: string,
): number | undefined {
  if (typeof issue.planEndDate === "number") return issue.planEndDate;
  const field = planEndFieldId
    ? issue.customFieldValues.find((f) => f.fieldId === planEndFieldId)
    : undefined;
  const raw = field?.values[0]?.displayValue;
  if (!raw) return undefined;
  if (/^\d{10,13}$/.test(raw)) {
    const n = Number(raw);
    // 10 位按秒补齐到毫秒
    return raw.length === 10 ? n * 1000 : n;
  }
  return parseLocalDateString(raw.trim());
}

/**
 * 议题状态名 → 云效官网四色系色调。
 * 云效 API 不返回状态颜色，只能按状态名硬映射（对照云效 Projex 默认工作流配色）；
 * 未匹配/自定义工作流状态一律回落灰色。
 */
export type YunxiaoStatusTone = "blue" | "green" | "orange" | "grey";

const STATUS_TONE_BY_NAME: Record<string, YunxiaoStatusTone> = {
  待处理: "blue",
  待确认: "blue",
  已确认: "blue",
  待开发: "green",
  开发中: "green",
  开发完成: "green",
  待测试: "green",
  测试中: "green",
  测试完成: "green",
  测试打回: "orange",
  发布中: "orange",
  验收完成: "orange",
  触发重置: "orange",
  发布完成: "orange",
  已完成: "grey",
  已创建: "grey",
  已拒绝: "grey",
  已取消: "grey",
  已关闭: "grey",
};

/** 终态状态名集合：逾期标红只看非终态（已完成的老议题不红）。 */
const TERMINAL_STATUS_NAMES = new Set(["已完成", "已拒绝", "已取消", "已关闭"]);

export function getYunxiaoStatusTone(issue: YunxiaoWorkitem): YunxiaoStatusTone {
  const name = issue.status?.displayName ?? issue.status?.name ?? "";
  return STATUS_TONE_BY_NAME[name] ?? "grey";
}

/**
 * 议题是否已逾期：计划完成时间早于今天 00:00 且状态非终态。
 * 终态（已完成/已拒绝/已取消/已关闭）即使日期早于今天也保持灰色。
 */
export function isYunxiaoIssueOverdue(issue: YunxiaoWorkitem, planEnd?: number): boolean {
  if (!planEnd) return false;
  const name = issue.status?.displayName ?? issue.status?.name ?? "";
  if (TERMINAL_STATUS_NAMES.has(name)) return false;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return planEnd < todayStart.getTime();
}

/** 计算当前被占用的议题 id 集合：
 *  - 任务直接绑定（补录待办 / 执行待办 / 直接执行任务）；
 *  - 方案占用——但以「仍存在 task.planId 指向该方案」为准（讨论任务 / 生成的待办存活期间）。
 *    讨论任务被删除后方案成为孤儿，不再占用议题：否则议题永远无法重新导入，
 *    且该方案在预览里也因 discussionTaskId 悬空而永远不可删。
 *  已取消方案一律不占用。 */
export function collectOccupiedYunxiaoWorkitemIds(
  tasks: Task[],
  plans: Plan[],
): Set<string> {
  const occupied = new Set<string>();
  const livePlanIds = new Set<string>();
  tasks.forEach((task) => {
    if (task.yunxiaoWorkitemId) occupied.add(task.yunxiaoWorkitemId);
    if (task.planId) livePlanIds.add(task.planId);
  });
  plans.forEach((plan) => {
    if (plan.status === "cancelled") return;
    if (!livePlanIds.has(plan.id)) return;
    plan.issues.forEach((issue) => occupied.add(issue.workitemId));
  });
  return occupied;
}

/** 去重判断：同议题只允许进入讨论/直接执行链路一次——任务直接绑定，
 *  或仍被存活任务引用的方案（讨论中/待生成待办/执行中/已完成）占用即视为已导入。 */
export function isYunxiaoWorkitemImported(
  tasks: Task[],
  plans: Plan[],
  workitemId: string,
): boolean {
  if (!workitemId) return false;
  return collectOccupiedYunxiaoWorkitemIds(tasks, plans).has(workitemId);
}

/**
 * 该任务启动时是否要求产出知识沉淀产物。
 *
 * 只有**云效议题的执行类任务**（方案执行 / 直接执行）为真：它们有议题上下文、改动
 * 落在真实代码上，收尾时才有值得沉淀的知识。方案讨论任务（`yunxiaoPlanDiscussion`）
 * 产出的是方案文档而非知识；普通任务没有议题绑定。这两类若被要求产出，一旦没写
 * `knowledge.json` 就会被判漏产出、误报并自动建云效议题——所以必须排除。
 */
export function requiresSedimentation(
  task: Pick<Task, "yunxiaoWorkitemId" | "yunxiaoPlanDiscussion">,
): boolean {
  return !!task.yunxiaoWorkitemId && !task.yunxiaoPlanDiscussion;
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

/** splitValueScoreSection 的返回：评论正文 + 只读评分小节 + 解析出的指数。 */
export interface SplitValueScoreSection {
  comment: string;
  scoreSection: string | null;
  scoreValue: number | null;
}

/**
 * 把回写内容拆成「评论正文」与「价值评分小节」两部分，并解析核心指数（Req）/优先指数（Bug）。
 * 评分小节从 `## 价值评分` 标题行起，到下一个 `## ` 标题或文本末尾止。
 */
export function splitValueScoreSection(text: string): SplitValueScoreSection {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(VALUE_SCORE_SECTION_HEADER));
  if (start === -1) {
    return { comment: text.trim(), scoreSection: null, scoreValue: null };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  const before = lines.slice(0, start).join("\n").trimEnd();
  const after = lines.slice(end).join("\n").trimStart();
  const comment = [before, after].filter((part) => part.length > 0).join("\n\n");
  return {
    comment,
    scoreSection: section.length > 0 ? section : null,
    scoreValue: section.length > 0 ? parseValueScoreIndex(section) : null,
  };
}

function parseValueScoreIndex(section: string): number | null {
  for (const rawLine of section.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^-\s*(?:核心指数|优先指数)[:：]\s*(.*)$/);
    if (!match) continue;
    const rest = match[1].replace(/\*/g, "").trim();
    const number = rest.match(/-?\d+(?:\.\d+)?/);
    if (number) {
      const value = Number(number[0]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}
