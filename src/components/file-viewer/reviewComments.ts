import type { Task, TaskStatus } from "../../types";

/**
 * 行级 Review 评论（纯前端内存态，不持久化）。
 *
 * 生命周期：项目会话内存活——切面板 / 切文件不丢，切项目清空，应用重启丢失。
 * 是「Review 时和 Agent 沟通」的临时产物；发送后消息留在会话 JSONL 里天然留痕。
 */
export interface ReviewComment {
  id: string;
  /** 相对项目根的路径（统一 / 分隔） */
  path: string;
  startLine: number;
  endLine: number;
  /** 选中的代码原文快照（已按 R1 截断） */
  snippet: string;
  text: string;
  status: "open" | "resolved";
  /** 发送时间；未发送为 undefined */
  sentAt?: number;
  /** 创建 / 发送时锚定的任务 id */
  taskId?: string;
  createdAt: number;
}

/** 创建评论时的输入（锚点 + 正文由编辑器组件计算） */
export interface CommentDraft {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  text: string;
}

export const MAX_SNIPPET_LINES = 50;
export const MAX_SNIPPET_CHARS = 2000;

/** 生成评论 id（webview 环境优先 crypto.randomUUID，兜底时间戳+随机） */
export function newCommentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function toRelativeProjectPath(projectPath: string, filePath: string): string {
  const prefix = projectPath.replace(/[\\/]+$/, "");
  let rel = filePath;
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  return rel.replace(/^[\\/]+/, "").replace(/\\/g, "/");
}

/** 拼接评论的相对路径到绝对路径（统一 / 分隔，供 tab 匹配） */
export function joinProjectPath(projectPath: string, relPath: string): string {
  return `${projectPath.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/${relPath}`;
}

/** R1：多行上限 50 行 / snippet 2000 字符，超长截断并附省略标记 */
export function truncateSnippet(snippet: string): string {
  let s = snippet;
  let truncated = false;
  const lines = s.split("\n");
  if (lines.length > MAX_SNIPPET_LINES) {
    s = lines.slice(0, MAX_SNIPPET_LINES).join("\n");
    truncated = true;
  }
  if (s.length > MAX_SNIPPET_CHARS) {
    s = s.slice(0, MAX_SNIPPET_CHARS);
    truncated = true;
  }
  return truncated ? `${s}\n…` : s;
}

function fileExtension(path: string): string {
  const base = path.split("/").pop() ?? "";
  const idx = base.lastIndexOf(".");
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : "";
}

function quoteBody(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** 单条评论的消息块：@路径:行号 + 代码片段 + > 正文（Claude Code 原生引用语法） */
export function buildCommentMessage(comment: ReviewComment | CommentDraft): string {
  const range =
    comment.startLine === comment.endLine
      ? `:${comment.startLine}`
      : `:${comment.startLine}-${comment.endLine}`;
  const ref = `@${comment.path}${range}`;
  const snippet = comment.snippet
    ? `\`\`\`${fileExtension(comment.path)}\n${comment.snippet}\n\`\`\``
    : "";
  const body = quoteBody(comment.text);
  return [ref, snippet, body].filter(Boolean).join("\n");
}

/** 批量合并：多条评论 → 一条消息（AI 一轮全部处理，决策 8） */
export function buildBatchMessage(
  comments: Array<ReviewComment | CommentDraft>,
): string {
  return comments.map(buildCommentMessage).join("\n\n");
}

/** 可直接直投 PTY 的任务状态（进程存活、PTY writer 可用） */
const SENDABLE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "pending",
  "running",
  "input_required",
  "awaiting_review",
]);

export function isSendableStatus(status: TaskStatus): boolean {
  return SENDABLE_STATUSES.has(status);
}

/** 目标任务判定优先级：awaiting_review → input_required → running → 最近活跃（决策 9） */
const TARGET_PRIORITY: readonly TaskStatus[] = [
  "awaiting_review",
  "input_required",
  "running",
];

export function resolveTargetTask(tasks: Task[]): Task | null {
  for (const status of TARGET_PRIORITY) {
    const hit = tasks.find((task) => task.status === status);
    if (hit) return hit;
  }
  let best: Task | null = null;
  for (const task of tasks) {
    if (!isSendableStatus(task.status)) continue;
    if (!best) {
      best = task;
      continue;
    }
    const tTime = task.updatedAt ?? task.createdAt;
    const bestTime = best.updatedAt ?? best.createdAt;
    if (tTime > bestTime) best = task;
  }
  return best;
}
