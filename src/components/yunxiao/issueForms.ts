/**
 * 云效议题补充表单定义（v2 详情页）。
 * 需求类（Req/Task）与缺陷类（Bug）各有一套固定字段；字段/逻辑均为纯 TS，便于测试。
 */

export type IssueFormKind = "requirement" | "bug";

export interface IssueFormField {
  key: string;
  labelKey: string;
}

/** 需求类表单字段：标题 / 当前痛点 / 期望行为 / 备选方案 / 补充说明 */
export const ISSUE_FORM_FIELDS: Record<IssueFormKind, IssueFormField[]> = {
  requirement: [
    { key: "subject", labelKey: "yunxiao.form.subject" },
    { key: "pain", labelKey: "yunxiao.form.pain" },
    { key: "expectation", labelKey: "yunxiao.form.expectation" },
    { key: "alternative", labelKey: "yunxiao.form.alternative" },
    { key: "notes", labelKey: "yunxiao.form.notes" },
  ],
  bug: [
    { key: "subject", labelKey: "yunxiao.form.subject" },
    { key: "problem", labelKey: "yunxiao.form.problem" },
    { key: "expectation", labelKey: "yunxiao.form.expectation" },
    { key: "repro", labelKey: "yunxiao.form.repro" },
    { key: "regression", labelKey: "yunxiao.form.regression" },
    { key: "notes", labelKey: "yunxiao.form.notes" },
  ],
};

/** 字段 key → 中文标签（拼入定稿 prompt 给 Agent 看的最终文本）。 */
export const ISSUE_FORM_FIELD_LABELS: Record<string, string> = {
  subject: "标题",
  pain: "当前痛点",
  expectation: "期望行为",
  alternative: "备选方案",
  problem: "问题描述",
  repro: "复现步骤",
  regression: "回归信息",
  notes: "补充说明",
};

/** 云效类别 → 补充表单类型：Req/Task 走需求表单，Bug 走缺陷表单，未知回退需求表单。 */
export function categoryToFormKind(categoryId?: string): IssueFormKind {
  const category = (categoryId ?? "").trim().toLowerCase();
  return category === "bug" ? "bug" : "requirement";
}

/** 讨论 Skill（与后端 get_issue_discussion_instructions 的映射一致）。 */
export function discussionSkillForCategory(categoryId?: string): "grilling" | "diagnosing-bugs" | "none" {
  const category = (categoryId ?? "").trim().toLowerCase();
  if (category === "bug") return "diagnosing-bugs";
  if (category === "req") return "grilling";
  return "none";
}

/** 定稿数据是否存在有效内容（任一字段非空即视为已定稿）。 */
export function hasSupplementValues(fields?: Record<string, string>): boolean {
  return !!fields && Object.values(fields).some((v) => v.trim().length > 0);
}

/**
 * 定稿 prompt：按表单字段顺序拼「中文标签: 值」，跳过空值；
 * 保留原始议题内容，末尾追加云效链接。
 */
export function buildSupplementedPrompt(
  kind: IssueFormKind,
  values: Record<string, string>,
  originalPrompt: string,
  link: string,
): string {
  const lines: string[] = [];
  for (const field of ISSUE_FORM_FIELDS[kind]) {
    const value = (values[field.key] ?? "").trim();
    if (!value) continue;
    lines.push(`${ISSUE_FORM_FIELD_LABELS[field.key] ?? field.key}: ${value}`);
  }
  const original = originalPrompt.trim();
  if (original) {
    lines.push("", "---", original);
  }
  const trimmedLink = link.trim();
  if (trimmedLink) {
    lines.push("", `云效链接：${trimmedLink}`);
  }
  return lines.join("\n");
}

/** 定稿补充字段 → 供回写汇总的事实文本（"中文标签: 值"，跳过空值）。 */
export function buildYunxiaoFieldsText(fields?: Record<string, string>): string {
  if (!fields) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const text = (value ?? "").trim();
    if (!text) continue;
    lines.push(`${ISSUE_FORM_FIELD_LABELS[key] ?? key}: ${text}`);
  }
  return lines.join("\n");
}
