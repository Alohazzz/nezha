// Mermaid 代码块识别（对照 ZCode packages/ui/src/lib/mermaidLanguage.ts）。
// 模型经常输出未标注语言的 mermaid fenced code block，所以除了 lang === mermaid/mmd
// 的显式标注，还对空语言 / 纯文本语言做「首行图表关键字」窄识别——只在无语言的
// 代码块里生效，显式 ts/js/sh 等语言标签永远不会被误判成图表。

export function isMermaidLanguage(language: string): boolean {
  const normalized = language.trim().toLowerCase();
  return normalized === "mermaid" || normalized === "mmd";
}

const MERMAID_AUTODETECT_LANGUAGES = new Set(["", "text", "txt", "plain"]);
const MERMAID_LEADING_DIRECTIVE_PATTERN = /^---[\s\S]*?---\s*/;
const MERMAID_DIAGRAM_START_PATTERN =
  /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|sankey-beta|xychart-beta|block-beta|packet-beta|architecture-beta|c4(?:Context|Container|Component|Dynamic|Deployment))/i;

export function isLikelyMermaidCode(code: string): boolean {
  const firstMeaningfulLine = code
    .trim()
    .replace(MERMAID_LEADING_DIRECTIVE_PATTERN, "")
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);

  return firstMeaningfulLine
    ? MERMAID_DIAGRAM_START_PATTERN.test(firstMeaningfulLine.trim())
    : false;
}

export function shouldRenderMermaidCodeBlock(language: string, code: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (isMermaidLanguage(normalizedLanguage)) return true;
  return MERMAID_AUTODETECT_LANGUAGES.has(normalizedLanguage) && isLikelyMermaidCode(code);
}

// 渲染前预算门禁（对照 ZCode mermaidRenderBudget.ts）：超大规模图表的布局
// 计算是 O(节点数²) 且不可中断，一张失控的图能把 UI 线程卡死数十秒。超过任一
// 阈值就不自动渲染，保持纯代码块展示。
export const MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS = 20_000;
export const MERMAID_AUTO_RENDER_MAX_LINES = 600;
export const MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE = 1_500;

const MERMAID_EDGE_TOKEN_PATTERN = /(?:<-->|-->)|(?:<--|---)|(?:-\.-)|(?:===)|(?:~~~)|-\[|-\)|-\(/g;

export interface MermaidAutoRenderDecision {
  shouldRender: boolean;
  reason?: "source-too-large" | "too-many-lines" | "too-complex";
}

export function resolveMermaidAutoRenderDecision(code: string): MermaidAutoRenderDecision {
  if (code.length > MERMAID_AUTO_RENDER_MAX_SOURCE_CHARS) {
    return { shouldRender: false, reason: "source-too-large" };
  }
  const lines = code.split(/\r?\n/);
  if (lines.length > MERMAID_AUTO_RENDER_MAX_LINES) {
    return { shouldRender: false, reason: "too-many-lines" };
  }
  let complexityScore = lines.length;
  const edgeMatches = code.match(MERMAID_EDGE_TOKEN_PATTERN);
  complexityScore += edgeMatches ? edgeMatches.length : 0;
  const nodeMatches = code.match(/\[[^\]]+\]|\([^)]+\)|\{[^}]+\}/g);
  complexityScore += nodeMatches ? nodeMatches.length : 0;
  if (complexityScore > MERMAID_AUTO_RENDER_MAX_COMPLEXITY_SCORE) {
    return { shouldRender: false, reason: "too-complex" };
  }
  return { shouldRender: true };
}
