import type { CodexPatchChangeKind } from "../../types";

// ── codex-stream diff 纯解析层（issue #117 T4）────────────────────────────────
// unified diff 文本 / 上游 per-file 结构 → hunk 结构 + 派生 +N/−N 统计。
// 纯函数、零依赖、永不抛异常——上游 diff 可能被截断、可能带
// `\ No newline at end of file`、可能缺 hunk 头，坏输入返回可用的部分结果。
//
// 上游条目本来是 per-file 结构（CodexFileChangeItem.changes：path + kind + diff
// 文本），kind 信息（add/delete/update+movePath）比从头推断可靠；原始
// unified diff 文本路径保留给兜底/测试/未来单帧多文件形态。结构化形态可用时
// 其 kind 优先于 diff 头推断。

export type CodexDiffRowType = "add" | "del" | "context" | "meta";

export interface CodexDiffRow {
  type: CodexDiffRowType;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface CodexDiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  rows: CodexDiffRow[];
}

export type CodexDiffChangeKind = "added" | "deleted" | "renamed" | "modified";

export interface CodexDiffFile {
  /** 展示主路径（新路径优先；删除文件为旧路径）。 */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  changeKind: CodexDiffChangeKind;
  hunks: CodexDiffHunk[];
  additions: number;
  deletions: number;
}

/** 上游 CodexFileChangeItem.changes 元素（结构化形态）。 */
export interface CodexFileChangeInput {
  path: string;
  kind: CodexPatchChangeKind;
  diff: string;
}

/** 剥掉 git 的 a/ b/ 前缀与 /dev/null。 */
function cleanPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/dev/null") return null;
  return trimmed.replace(/^a\//, "").replace(/^b\//, "");
}

function kindFromChangeKind(
  kind: CodexPatchChangeKind,
  movePath: string | null,
): CodexDiffChangeKind {
  if (kind.type === "add") return "added";
  if (kind.type === "delete") return "deleted";
  return movePath ? "renamed" : "modified";
}

/** 单文件解析的游标：当前 hunk + 递增的旧行号 / 新行号。 */
interface HunkAccumulator {
  hunk: CodexDiffHunk | null;
  oldLine: number;
  newLine: number;
}

/** 单行 → 变更行分类（hunk 内）。返回 null 表示不是 diff 内容行。 */
function classifyHunkLine(line: string, acc: HunkAccumulator, file: CodexDiffFile): void {
  if (line.startsWith("+")) {
    acc.hunk!.rows.push({ type: "add", content: line.slice(1), newLine: acc.newLine });
    file.additions += 1;
    acc.newLine += 1;
  } else if (line.startsWith("-")) {
    acc.hunk!.rows.push({ type: "del", content: line.slice(1), oldLine: acc.oldLine });
    file.deletions += 1;
    acc.oldLine += 1;
  } else if (line.startsWith(" ")) {
    acc.hunk!.rows.push({
      type: "context",
      content: line.slice(1),
      oldLine: acc.oldLine,
      newLine: acc.newLine,
    });
    acc.oldLine += 1;
    acc.newLine += 1;
  } else if (line.startsWith("\\")) {
    // `\ No newline at end of file`：附着信息，不算变更行
    acc.hunk!.rows.push({ type: "meta", content: line });
  }
  // 空串（split 尾部产物）与无法识别的行静默跳过
}

/** 行是否开启新 hunk；是则建立 hunk 并写入 file（畸形头行号退化为 0，不丢后续行）。 */
function tryStartHunk(line: string, acc: HunkAccumulator, file: CodexDiffFile): boolean {
  if (!line.startsWith("@@")) return false;
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  const hunk: CodexDiffHunk = {
    header: line,
    oldStart: match ? Number(match[1]) : 0,
    oldLines: match && match[2] !== undefined ? Number(match[2]) : 0,
    newStart: match ? Number(match[3]) : 0,
    newLines: match && match[4] !== undefined ? Number(match[4]) : 0,
    rows: [],
  };
  file.hunks.push(hunk);
  acc.hunk = hunk;
  acc.oldLine = hunk.oldStart;
  acc.newLine = hunk.newStart;
  return true;
}

/** 把单文件 unified diff 文本块解析成 hunk 结构（宽容：坏行跳过、截断保留已解析部分）。 */
function parseHunkLines(diffText: string, file: CodexDiffFile): void {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const acc: HunkAccumulator = { hunk: null, oldLine: 0, newLine: 0 };

  for (const line of lines) {
    // hunk 外的内容（index / mode / diff --git 头等）一律忽略——kind 由结构化
    // kind 或调用侧从头推断，不在这里重复解析。
    if (!acc.hunk) {
      tryStartHunk(line, acc, file);
      continue;
    }
    if (!tryStartHunk(line, acc, file)) classifyHunkLine(line, acc, file);
  }
}

function emptyFile(path: string, changeKind: CodexDiffChangeKind): CodexDiffFile {
  return { path, oldPath: null, newPath: path, changeKind, hunks: [], additions: 0, deletions: 0 };
}

/**
 * 解析上游结构化 fileChange 条目（首选形态）：kind 直接来自上游权威字段，
 * diff 文本只负责 hunk / 行级结构与统计派生。
 */
export function parseCodexFileDiff(change: CodexFileChangeInput): CodexDiffFile {
  const movePath = change.kind.type === "update" ? change.kind.movePath : null;
  const kind = kindFromChangeKind(change.kind, movePath);
  const file = emptyFile(change.path, kind);

  try {
    // 从 diff 文本里补齐 old/new 路径与 /dev/null 语义（rename 路径等）
    for (const line of change.diff.replace(/\r\n/g, "\n").split("\n")) {
      if (line.startsWith("--- ")) file.oldPath = cleanPath(line.slice(4));
      else if (line.startsWith("+++ ")) file.newPath = cleanPath(line.slice(4));
    }
    if (kind === "renamed" && movePath) {
      file.oldPath = file.oldPath ?? change.path;
      file.newPath = movePath;
      file.path = movePath;
    }
    parseHunkLines(change.diff, file);
  } catch {
    // 防御性：path/diff 字段畸形（上游新版本改形状）时返回空结构
  }
  if (!file.path) file.path = file.newPath ?? file.oldPath ?? "(unknown file)";
  return file;
}

/**
 * 解析原始 unified diff 文本（多文件、兜底形态）。
 * git 扩展头（new file mode / deleted file mode / rename from|to）参与 kind 推断。
 */
export function parseCodexDiffText(diffText: string): CodexDiffFile[] {
  if (!diffText) return [];
  const files: CodexDiffFile[] = [];

  try {
    const lines = diffText.replace(/\r\n/g, "\n").split("\n");
    let current: CodexDiffFile | null = null;
    let headerNewFileMode = false;
    let headerDeletedFileMode = false;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    // 每个文件段一个游标；@@ 后的 +/-/context 行全部归属当前文件
    let acc: HunkAccumulator = { hunk: null, oldLine: 0, newLine: 0 };

    const flush = () => {
      if (!current) return;
      if (renameFrom && renameTo) {
        current.oldPath = renameFrom;
        current.newPath = renameTo;
        current.changeKind = "renamed";
        current.path = renameTo;
      } else if (headerNewFileMode || current.oldPath === null) {
        current.changeKind = "added";
      } else if (headerDeletedFileMode || current.newPath === null) {
        current.changeKind = "deleted";
        current.path = current.oldPath ?? current.path;
      }
      if (!current.path) current.path = current.newPath ?? current.oldPath ?? "(unknown file)";
      files.push(current);
    };

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        flush();
        current = emptyFile("", "modified");
        headerNewFileMode = false;
        headerDeletedFileMode = false;
        renameFrom = null;
        renameTo = null;
        acc = { hunk: null, oldLine: 0, newLine: 0 };
        continue;
      }
      if (!current) continue;
      if (line.startsWith("--- ")) current.oldPath = cleanPath(line.slice(4));
      else if (line.startsWith("+++ ")) current.newPath = cleanPath(line.slice(4));
      else if (line.startsWith("new file mode")) headerNewFileMode = true;
      else if (line.startsWith("deleted file mode")) headerDeletedFileMode = true;
      else if (line.startsWith("rename from ")) renameFrom = cleanPath(line.slice("rename from ".length));
      else if (line.startsWith("rename to ")) renameTo = cleanPath(line.slice("rename to ".length));
      else if (!tryStartHunk(line, acc, current)) classifyHunkLine(line, acc, current);
    }
    flush();
  } catch {
    // 永不抛异常：截断/畸形输入保留已解析文件
  }
  return files;
}

/** 汇总 +N/−N（多文件父卡）。 */
export function summarizeCodexDiffFiles(files: CodexDiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );
}

export interface TruncatedCodexDiffFile {
  file: CodexDiffFile;
  truncated: boolean;
  totalRows: number;
  omittedRows: number;
}

/** 单文件行数护栏：超出 limit 截前 limit 行，报告省略量（尾部入口跳 GitChanges 面板）。 */
export function truncateCodexDiffFile(file: CodexDiffFile, limit: number): TruncatedCodexDiffFile {
  const totalRows = file.hunks.reduce((n, h) => n + h.rows.length, 0);
  if (totalRows <= limit) {
    return { file, truncated: false, totalRows, omittedRows: 0 };
  }
  let remaining = limit;
  const hunks: CodexDiffHunk[] = [];
  for (const hunk of file.hunks) {
    if (remaining <= 0) break;
    const rows = hunk.rows.slice(0, remaining);
    remaining -= rows.length;
    hunks.push({ ...hunk, rows });
  }
  return {
    file: { ...file, hunks },
    truncated: true,
    totalRows,
    omittedRows: totalRows - limit,
  };
}

// ── 扩展名 → shiki 语言（小表；未命中返回 null 走纯文本，不猜）────────────────

const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  css: "css",
  scss: "scss",
  html: "html",
  htm: "html",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
};

export function guessDiffLanguage(path: string | null | undefined): string | null {
  if (!path) return null;
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return null;
  return EXT_TO_LANGUAGE[path.slice(dot + 1).toLowerCase()] ?? null;
}
