import type { CodexStreamEntry } from "../../hooks/codexStreamMerge";

// ── 命令摘要与聚合（对标 ZCode execute / execute-group）──────────────────────
// 两个纯函数，供视图层在渲染前使用：
// 1. summarizeCommand：剥掉 `bash.exe -lc "..."` / `pwsh.exe -Command '...'`
//    这类 shell 包裹，摘要行只显示智能体真正想执行的那条命令。原始命令仍保留在
//    item 上，展开区完整显示（可复制）。
// 2. groupCommandEntries：把**连续**的 commandExecution 条目聚合为一行组摘要
//    （≥2 条才成组），这是降低流视图密集度的主要手段。单条命令保持独立渲染，
//    与 ZCode 的「单个工具不额外套一层 Terminal 容器」一致。
//
// 分组只发生在视图层：归并模型 / byId 索引 / 持久化都不动，便于单测与回滚。

/** 摘要行剥离的 shell 包裹形态。 */
const SHELL_WRAPPER_RE =
  /^"?((?:[^"]*[\\/])?(?:bash|zsh|sh|pwsh|powershell)(?:\.exe)?)"?\s+(?:(?:-NoProfile|-NoLogo|-NonInteractive|--noprofile|-ExecutionPolicy\s+\S+)\s+)*(-l?c|-Command)\s+([\s\S]+)$/i;

/** 去掉包裹命令的外层引号（成对才剥），并还原同类引号的转义。 */
function unquoteCommand(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (first !== last || (first !== '"' && first !== "'")) return trimmed;
  const inner = trimmed.slice(1, -1);
  return first === '"' ? inner.replace(/\\"/g, '"') : inner.replace(/\\'/g, "'");
}

/**
 * 命令摘要：能识别 shell 包裹时返回内部命令，否则原样返回。
 * 仅用于摘要行展示——展开区与复制都使用原始 `item.command`。
 */
export function summarizeCommand(command: string | null | undefined): string {
  const raw = typeof command === "string" ? command.trim() : "";
  if (raw.length === 0) return "";
  const match = SHELL_WRAPPER_RE.exec(raw);
  if (!match) return raw;
  const inner = unquoteCommand(match[3] ?? "");
  return inner.length > 0 ? inner : raw;
}

/** 聚合组里的单个命令条目（保留原始位置序号，fallback 展开键等仍按原序）。 */
export type CodexCommandGroupChild = {
  entry: Extract<CodexStreamEntry, { kind: "commandExecution" }>;
  entryIndex: number;
};

/** 视图渲染项：普通条目或连续命令聚合组。 */
export type CodexRenderItem =
  | { kind: "entry"; entry: CodexStreamEntry; entryIndex: number }
  | { kind: "commandGroup"; groupKey: string; commands: CodexCommandGroupChild[] };

/**
 * 把条目序列折叠为渲染项序列。
 *
 * 只有**相邻**的 commandExecution 会并进同一组；任何其它条目（回复 / 思考 /
 * 文件变更 / MCP / 未知）都是分组边界。组 identity 锚定首条命令 id——流式追加
 * 新命令时组组件不会被重建，CodexToolCard 里按 entryId 持久化的展开态才不会丢。
 */
export function groupCommandEntries(entries: readonly CodexStreamEntry[]): CodexRenderItem[] {
  const items: CodexRenderItem[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (!entry) break;

    if (entry.kind !== "commandExecution") {
      items.push({ kind: "entry", entry, entryIndex: index });
      index += 1;
      continue;
    }

    const run: CodexCommandGroupChild[] = [];
    while (index < entries.length) {
      const next = entries[index];
      if (!next || next.kind !== "commandExecution") break;
      run.push({ entry: next, entryIndex: index });
      index += 1;
    }

    const first = run[0];
    if (!first) continue;
    if (run.length === 1) {
      items.push({ kind: "entry", entry: first.entry, entryIndex: first.entryIndex });
    } else {
      items.push({
        kind: "commandGroup",
        groupKey: `execute:${first.entry.item.id}`,
        commands: run,
      });
    }
  }

  return items;
}
