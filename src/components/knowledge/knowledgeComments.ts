/**
 * 知识库卡片修改意见（纯前端内存态，不持久化）。
 *
 * 与文件批注（ReviewComment）同构：发送后消息留在会话 JSONL 里天然留痕。
 * 区别是锚点不是「行号」，而是「整张卡片」——用知识库仓库内卡片的绝对路径，
 * 这样跑在项目任务里的 Agent 也能跨仓库定位到要改的卡片文件。
 */
export interface KnowledgeComment {
  id: string;
  /** 模块名（卡片文件名去掉 .md） */
  module: string;
  /** 知识库仓库内卡片的绝对路径（`.../data/modules/<module>.md`） */
  absPath: string;
  /** 修改指令 */
  text: string;
  status: "open" | "resolved";
  taskId?: string;
  createdAt: number;
  sentAt?: number;
}

/** 生成评论 id（webview 环境优先 crypto.randomUUID，兜底时间戳+随机） */
export function newKnowledgeCommentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 由知识库 data 目录 + 模块名拼出卡片绝对路径（统一 / 分隔）。 */
export function cardAbsPath(dataDir: string, module: string): string {
  return `${dataDir.replace(/\\/g, "/")}/modules/${module}.md`;
}

/** 单条修改意见的消息块：@卡片绝对路径 + > 指令（Agent 借此跨仓库定位卡片）。 */
export function buildKnowledgeCommentMessage(comment: KnowledgeComment): string {
  return [
    `@${comment.absPath}`,
    comment.text
      .trim()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    "",
    "【上下文】当前项目代码即工作目录（cwd），请结合实际代码核实、补充卡片内容。",
    "【约束】只修改上面 @ 指向的这一张知识库卡片，不要改动项目代码、项目 git 或 worktree。",
  ].join("\n");
}

/** 批量合并：多条修改意见 → 一条消息（Agent 一轮全部处理）。 */
export function buildKnowledgeBatchMessage(comments: KnowledgeComment[]): string {
  return comments.map(buildKnowledgeCommentMessage).join("\n\n");
}
