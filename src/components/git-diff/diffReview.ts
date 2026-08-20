import type { ReviewComment } from "../file-viewer/reviewComments";
import type { DiffLineType } from "./types";

/**
 * diff 视图身份（键控粒度，见决策 7）：
 * - worktree：工作区单文件 diff，按 (filePath, staged) 独立
 * - commit：commit 系按 (commitHash, filePath) 归并；整仓视图（filePath 缺省）
 *   匹配该 commit 的全部文件，单文件视图只匹配该文件
 */
export type DiffKey =
  | { kind: "worktree"; filePath: string; staged: boolean }
  | { kind: "commit"; commitHash: string; filePath?: string };

export function diffKeyString(key: DiffKey): string {
  if (key.kind === "worktree") {
    return `worktree\0${key.filePath}\0${key.staged ? "staged" : "unstaged"}`;
  }
  return `commit\0${key.commitHash}\0${key.filePath ?? ""}`;
}

/** 评论是否属于当前打开的 diff（commit 整仓视图按 commitHash 前缀匹配全部文件） */
export function commentMatchesDiff(comment: DiffReviewComment, key: DiffKey): boolean {
  if (key.kind === "commit") {
    const prefix = `commit\0${key.commitHash}\0`;
    if (!comment.diffKey.startsWith(prefix)) return false;
    // 整仓视图匹配该 commit 的全部文件；单文件视图精确匹配
    return key.filePath == null || comment.diffKey === diffKeyString(key);
  }
  return comment.diffKey === diffKeyString(key);
}

/** diff 单行批注草稿（行号由行类型决定：add→newLine / remove→oldLine / context→newLine） */
export interface DiffCommentDraft {
  /** 相对仓库根的路径（git 报告路径，统一 / 分隔） */
  path: string;
  line: number;
  snippet: string;
  text: string;
  /** false = 纯文本锚（removed 行 / commit diff） */
  anchorable: boolean;
  /** 所属 diff 身份键，见 diffKeyString */
  diffKey: string;
}

export interface DiffReviewComment extends ReviewComment {
  /** 所属 diff 身份键，见 diffKeyString */
  diffKey: string;
  /** false = 纯文本锚（removed 行 / commit diff） */
  anchorable: boolean;
}

/** 行类型 → 是否可用 `@路径:行号` 锚定：仅工作区 diff 的 add / context 行 */
export function isAnchorableRow(type: DiffLineType, allowMentions: boolean): boolean {
  return allowMentions && (type === "add" || type === "context");
}
