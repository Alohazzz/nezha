import type { CodexStreamEntry } from "../../hooks/codexStreamMerge";
import { groupCommandEntries, type CodexRenderItem } from "./codexCommandSummary";

// ── 轮次分段（对标 ZCode ConversationTurnWorkSegment）─────────────────────────
// 结构化流此前是一条**平铺条目流**：命令、思考、中间叙述、最终答复权重相同地往
// 下滚，任务结束时只剩最后一屏工具日志——「过程」和「完成」都糊在一起。
//
// 这里按 ZCode 的轮次模型重切：一条用户输入开启一轮，轮内的工具 / 思考 / 中间
// 叙述是**过程**，轮内最后一条助手消息是**结论**。过程收进「已工作 X 秒」的
// 折叠段，结论留在主线上——完成的那一刻，用户先看到「这一轮花了多久」，再看到
// 做完了什么，而不是继续读工具日志。
//
// 纯函数：只做分组与时间归集，不依赖 React，单测可直接驱动。

export type CodexTurnWorkState = "running" | "completed" | "interrupted";

export interface CodexTurnSegment {
  /** 分段稳定键：锚定用户消息 id（delta 增长不会改变它）。 */
  key: string;
  userMessage: Extract<CodexStreamEntry, { kind: "userMessage" }>;
  /** 过程渲染项（连续命令已聚合）；已剔除被提升为结论的那条消息。 */
  processItems: CodexRenderItem[];
  /** 结论：轮内最后一条助手消息，且本轮已结束。运行中不提升。 */
  answer: Extract<CodexStreamEntry, { kind: "agentMessage" }> | null;
  /** 本轮状态。只有最后一段可能 running / interrupted。 */
  state: CodexTurnWorkState;
  /** 过程耗时锚点（毫秒）：段内条目时间戳的最小 / 最大值。 */
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** 初始折叠态：运行 / 中断 / 本轮没有结论时才展开。 */
  defaultOpen: boolean;
}

export interface CodexTurnSegmentation {
  /** 以用户输入为界的轮次段，按出现顺序。 */
  segments: CodexTurnSegment[];
  /** 第一条用户消息之前的条目（会话从助手侧开始 / 冷恢复续跑）。
   *  这类内容没有「这一轮要什么」的前提，不参与折叠——用户没发起过这些动作，
   *  藏起来就成了「自己跑出来的东西」。 */
  orphanItems: CodexRenderItem[];
}

/** 段内最早开始时刻：条目时间字段缺失（回放 / 用户消息）时返回 null。 */
function earliestStart(entries: readonly CodexStreamEntry[]): number | null {
  let best: number | null = null;
  for (const entry of entries) {
    const ts = entry.startedAtMs;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (best === null || ts < best) best = ts;
  }
  return best;
}

/** 段内最晚结束时刻：只有完成过的条目会写 endedAtMs。 */
function latestEnd(entries: readonly CodexStreamEntry[]): number | null {
  let best: number | null = null;
  for (const entry of entries) {
    const ts = entry.endedAtMs;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (best === null || ts > best) best = ts;
  }
  return best;
}

interface SegmentDraft {
  userMessage: Extract<CodexStreamEntry, { kind: "userMessage" }>;
  rows: CodexStreamEntry[];
  /** rows[0] 在原始 entries 里的位置：fallback 展开键沿用全局序号，避免跨段碰撞。 */
  offset: number;
}

/**
 * 条目流 → 轮次分段。
 *
 * - 用户消息（含 steer 引导消息）开启新段：过程是「这一条指令之后干了什么」，
 *   而不是跨指令混在一起；
 * - 只有最后一段继承全局 running / interrupted，历史段一律按已完成收口；
 * - 结论取**轮内最后一条助手消息**（ZCode 的 latestAssistantTextRow 同款）。
 *   只认最后一条而不是「末条目」：模型偶尔以 reasoning / plan 收尾，末条目判定
 *   会让整轮折叠后一个字都不剩。
 */
export function segmentTurnEntries(
  entries: readonly CodexStreamEntry[],
  options: { running: boolean; interrupted?: boolean },
): CodexTurnSegmentation {
  const orphanRows: CodexStreamEntry[] = [];
  const drafts: SegmentDraft[] = [];

  entries.forEach((entry, index) => {
    if (entry.kind === "userMessage") {
      drafts.push({ userMessage: entry, rows: [], offset: index + 1 });
      return;
    }
    if (drafts.length === 0) {
      orphanRows.push(entry);
      return;
    }
    drafts[drafts.length - 1].rows.push(entry);
  });

  const segments = drafts.map((draft, index) => {
    const isLast = index === drafts.length - 1;
    const state: CodexTurnWorkState = !isLast
      ? "completed"
      : options.running
        ? "running"
        : options.interrupted
          ? "interrupted"
          : "completed";

    const rows = draft.rows;
    // 运行中不提升：正文还在增长，提前提到折叠区外会让完成瞬间整段重排。
    let answerIndex = -1;
    if (state !== "running") {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]?.kind === "agentMessage") {
          answerIndex = i;
          break;
        }
      }
    }
    const answer =
      answerIndex >= 0
        ? (rows[answerIndex] as Extract<CodexStreamEntry, { kind: "agentMessage" }>)
        : null;
    const processRows = answerIndex >= 0 ? rows.filter((_, i) => i !== answerIndex) : rows;

    const startedAtMs = earliestStart(rows) ?? draft.userMessage.startedAtMs ?? null;
    const rawEnd = state === "running" ? null : latestEnd(rows);
    // 本地时钟占位起点 + 后端信封完成时刻的时钟偏差可能给出负值：不渲染负时长。
    const endedAtMs =
      rawEnd !== null && startedAtMs !== null && rawEnd < startedAtMs ? null : rawEnd;

    return {
      key: `turn:${index}:${draft.userMessage.item.id}`,
      userMessage: draft.userMessage,
      processItems: groupCommandEntries(processRows).map((item) =>
        item.kind === "commandGroup" ? item : { ...item, entryIndex: item.entryIndex + draft.offset },
      ),
      answer,
      state,
      startedAtMs,
      endedAtMs,
      // 运行中要能看见实况；中断要能看见停在哪；本轮没有结论时过程本身就是结果。
      defaultOpen: state !== "completed" || answer === null,
    } satisfies CodexTurnSegment;
  });

  return { segments, orphanItems: groupCommandEntries(orphanRows) };
}
