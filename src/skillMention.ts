/**
 * 技能提及的两种形态（对齐 ZCode 的 canonical mention 设计）：
 * - 紧凑形态 `$name`：输入框、消息气泡、任务标题里的展示载体，短且可读；
 * - canonical 形态「请读取并遵循 <label> 技能：<path>/SKILL.md」：真正提交给
 *   agent 的提示词实体，agent 按路径读取技能文件。
 *
 * 输入框只放紧凑形态，展开发生在提交前（`expandSkillTokens`）；消息气泡再把
 * canonical 折回紧凑形态（`splitSkillMentions`），让历史回放也保持短文本。
 *
 * 本模块不依赖 React / 后端类型，只定义展开与折叠的字符串协议。
 */

/** 技能的最小结构（`Skill` / `SkillRef` 都满足）。 */
export interface SkillRef {
  name: string;
  displayName?: string;
  path: string;
}

/** 指令里的技能展示名：frontmatter displayName 优先，缺省用目录名。 */
export function skillLabel(skill: SkillRef): string {
  return skill.displayName || skill.name;
}

/** 输入框里的紧凑引用。 */
export function skillToken(skill: SkillRef): string {
  return `$${skill.name}`;
}

/** canonical 技能指令。文案与历史 `expandMentionItem` 输出逐字一致——展开前后
 *  agent 收到的提示词完全相同，这次改动只影响展示层。 */
export function skillInstruction(skill: SkillRef): string {
  return `请读取并遵循 ${skillLabel(skill)} 技能：${skill.path}/SKILL.md`;
}

/** `$name` 词元：技能目录名是 slug，按 [A-Za-z0-9._-] 取词，避免吞掉标点。 */
const SKILL_TOKEN_PATTERN = /\$([A-Za-z0-9][A-Za-z0-9._-]*)/g;

/** canonical 指令片段：label 可能含空格，path 可能含空格，都按非贪婪匹配。 */
const SKILL_INSTRUCTION_PATTERN = /请读取并遵循\s+([\s\S]+?)\s*技能：\s*([\s\S]+?SKILL\.md)/g;

export type SkillMentionPart =
  | { type: "text"; text: string }
  | { type: "skill"; label: string; path: string };

/**
 * 把输入框文本里的 `$name` 展开为 canonical 指令。
 * 只展开 `skills` 里真实存在的技能：未知词元原样保留（可能是用户自己写的
 * shell 变量或其他 `$` 用法），避免误改写提示词。
 */
export function expandSkillTokens(text: string, skills: readonly SkillRef[]): string {
  if (!text.includes("$") || skills.length === 0) return text;
  const byName = new Map<string, SkillRef>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, skill);
  }
  return text.replace(SKILL_TOKEN_PATTERN, (raw, name: string) => {
    const skill = byName.get(name.toLowerCase());
    return skill ? skillInstruction(skill) : raw;
  });
}

/** 把 canonical 指令拆成「文本 / 技能」片段，供气泡渲染成 chip。 */
export function splitSkillMentions(text: string): SkillMentionPart[] {
  const parts: SkillMentionPart[] = [];
  let cursor = 0;
  SKILL_INSTRUCTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(SKILL_INSTRUCTION_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ type: "text", text: text.slice(cursor, start) });
    parts.push({
      type: "skill",
      label: (match[1] ?? "").trim(),
      path: (match[2] ?? "").trim(),
    });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", text: text.slice(cursor) });
  return parts;
}

/** 把 canonical 指令折叠成纯文本紧凑形态（任务标题等无富文本的展示位用）。 */
export function compactSkillMentions(text: string): string {
  return splitSkillMentions(text)
    .map((part) => (part.type === "skill" ? `$${part.label}` : part.text))
    .join("");
}
