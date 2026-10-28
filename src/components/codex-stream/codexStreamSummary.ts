import type { CodexStreamEntry } from "../../hooks/codexStreamMerge";
import type { CodexTurnSegment } from "./codexTurnSegments";

// ── 整场会话的收口统计（完成后页脚）────────────────────────────────────────
// 「任务完成了」此前只有顶部一句横幅（失败才有）或干脆没有——流走到最后一条
// 工具卡就停住，用户得自己数「到底干了多少、花了多久」。这里从条目流里聚合
// 三个一眼有用的数：有效工作时长、命令数（含失败数）、改动文件数。
//
// 纯函数：不依赖 React，单测直接喂条目。

export interface CodexStreamSummary {
  /** 各轮有效工作时长之和（段内起止之差；缺时间戳的轮次不计）。 */
  workMs: number;
  /** 执行过的命令总数。 */
  commands: number;
  /** 失败的命令 / MCP / 文件变更总数。 */
  failures: number;
  /** 改动文件去重后的数量。 */
  filesChanged: number;
}

function sumSegmentWork(segments: readonly CodexTurnSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.startedAtMs === null || segment.endedAtMs === null) continue;
    const delta = segment.endedAtMs - segment.startedAtMs;
    if (delta > 0) total += delta;
  }
  return total;
}

/**
 * 聚合整场会话的收口统计。
 *
 * 时长按**分段求和**而不是「首条到末条」：多轮会话中间的大量空闲（去开会、
 * 隔夜续聊）不该算进「工作了多久」。
 */
export function summarizeCodexStream(
  entries: readonly CodexStreamEntry[],
  segments: readonly CodexTurnSegment[],
): CodexStreamSummary {
  let commands = 0;
  let failures = 0;
  const files = new Set<string>();

  for (const entry of entries) {
    if (entry.kind === "commandExecution") {
      commands += 1;
      if (entry.item.status === "failed" || entry.item.status === "declined") failures += 1;
    } else if (entry.kind === "mcpToolCall") {
      if (entry.item.status === "failed") failures += 1;
    } else if (entry.kind === "fileChange") {
      if (entry.item.status === "failed" || entry.item.status === "declined") failures += 1;
      for (const change of entry.item.changes) {
        if (change.path) files.add(change.path);
      }
    }
  }

  return { workMs: sumSegmentWork(segments), commands, failures, filesChanged: files.size };
}
