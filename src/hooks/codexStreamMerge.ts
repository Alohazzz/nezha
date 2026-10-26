import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexMcpToolCallItem,
  CodexPlanItem,
  CodexReasoningItem,
  CodexStreamFrame,
  CodexThreadItem,
  CodexTokenUsage,
  CodexUserMessageItem,
} from "../types";

// ── 流式归并纯函数层（issue #117 T1）─────────────────────────────────────────
// 帧 JSON → model 状态转换不依赖 React/Tauri，供 useCodexStream 接线与单测直接
// 驱动（spec「主接缝」）。归并语义自 T1 起为**不可变更新**：delta 追加一律生成
// 新条目对象并同步改写 entries 槽位与 byId 索引，条目对象本身在进入模型后不再
// 被原地 mutate——memo 化的下游卡片靠引用比较即可观察到每一次增量（修复"文本
// 完成后一次性闪现"）。
//
// revision：条目级递增修订号。started / 权威 completed 建立的条目从 0 起，每次
// delta 在新对象上 +1，供卡片判断"正在增长"触发自动展开（spec Implementation
// Decisions「数据层」）。

/** agentMessage / plan / reasoning 条目的流式累积形态。 */
type StreamingText =
  | { kind: "agentMessage"; item: CodexAgentMessageItem }
  | { kind: "plan"; item: CodexPlanItem }
  | { kind: "reasoning"; item: CodexReasoningItem };

/** 视图条目：渲染分发的判别形态。revision 见模块头注释。 */
export type CodexStreamEntry =
  | { kind: "userMessage"; item: CodexUserMessageItem; revision: number }
  | { kind: "agentMessage"; item: CodexAgentMessageItem; revision: number }
  | { kind: "plan"; item: CodexPlanItem; revision: number }
  | { kind: "reasoning"; item: CodexReasoningItem; revision: number }
  | { kind: "commandExecution"; item: CodexCommandExecutionItem; revision: number }
  | { kind: "fileChange"; item: CodexFileChangeItem; revision: number }
  | { kind: "mcpToolCall"; item: CodexMcpToolCallItem; revision: number }
  | { kind: "fallback"; item: CodexThreadItem; revision: number };

export interface StreamModel {
  entries: CodexStreamEntry[];
  byId: Map<string, CodexStreamEntry>;
  usage: CodexTokenUsage | null;
}

/** 长任务内存护栏；超出后丢最老的条目（原 hook 常量迁入，语义不变）。 */
export const MAX_ENTRIES = 5000;

export function createStreamModel(): StreamModel {
  return { entries: [], byId: new Map(), usage: null };
}

function classifyItem(item: CodexThreadItem): CodexStreamEntry {
  // CodexItemFallback.type 是宽 string，与字面量 case 无法收窄；
  // 按 shape 探测（fallback 是"只有 type + 未知键"的宽松接口）先行排除。
  if (item.type === "userMessage") return { kind: "userMessage", item: item as CodexUserMessageItem, revision: 0 };
  if (item.type === "agentMessage") return { kind: "agentMessage", item: item as CodexAgentMessageItem, revision: 0 };
  if (item.type === "plan") return { kind: "plan", item: item as CodexPlanItem, revision: 0 };
  if (item.type === "reasoning") return { kind: "reasoning", item: item as CodexReasoningItem, revision: 0 };
  if (item.type === "commandExecution")
    return { kind: "commandExecution", item: item as CodexCommandExecutionItem, revision: 0 };
  if (item.type === "fileChange") return { kind: "fileChange", item: item as CodexFileChangeItem, revision: 0 };
  if (item.type === "mcpToolCall") return { kind: "mcpToolCall", item: item as CodexMcpToolCallItem, revision: 0 };
  // 上游新增条目：保留不炸，但不参与视图渲染
  return { kind: "fallback", item, revision: 0 };
}

/** 已有条目的原位替换（保持顺序）：槽位与 byId 同步指向新 entry。 */
function replaceEntry(model: StreamModel, entry: CodexStreamEntry): void {
  const id = entry.item.id;
  const existing = id ? model.byId.get(id) : undefined;
  if (existing) {
    const idx = model.entries.indexOf(existing);
    if (idx >= 0) model.entries[idx] = entry;
  } else {
    model.entries.push(entry);
  }
  if (id) model.byId.set(id, entry);
}

function applyFrame(model: StreamModel, frame: CodexStreamFrame): void {
  if (frame.type === "tokenUsage") {
    const usage = frame.payload as CodexTokenUsage;
    if (usage && typeof usage === "object" && "total" in usage) {
      model.usage = usage;
    }
    return;
  }

  if (frame.type === "item") {
    const item = frame.payload as CodexThreadItem;
    replaceEntry(model, classifyItem(item));
    return;
  }

  // delta 帧：把增量归并到对应条目。started 帧可能尚未到达（上游乱序兜底），
  // 此时先建一条流式占位条目，completed 帧到达后会被权威快照替换。
  // 不可变语义：归并结果是新 entry 对象，旧对象（含其 item）保持原样。
  const delta = (frame.payload as { delta?: string }).delta ?? "";
  if (!delta) return;
  const key = frame.itemId || `__delta_${frame.type}`;
  const entry = model.byId.get(key);
  if (!entry) {
    // started 帧没到时先建流式占位条目；commandOutputDelta 的输出无处可挂则丢弃
    let streaming: StreamingText | null = null;
    if (frame.type === "agentMessageDelta") {
      streaming = {
        kind: "agentMessage",
        item: { type: "agentMessage", id: frame.itemId ?? "", text: delta },
      };
    } else if (frame.type === "reasoningDelta") {
      streaming = {
        kind: "reasoning",
        item: { type: "reasoning", id: frame.itemId ?? "", summary: [delta] },
      };
    }
    if (!streaming) return;
    const created: CodexStreamEntry = { ...streaming, revision: 0 };
    model.entries.push(created);
    model.byId.set(key, created);
    return;
  }

  if (frame.type === "agentMessageDelta" && entry.kind === "agentMessage") {
    const next: CodexStreamEntry = {
      kind: "agentMessage",
      item: { ...entry.item, text: entry.item.text + delta },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  } else if (frame.type === "reasoningDelta" && entry.kind === "reasoning") {
    // 流式 reasoning 文本放 summary[0]；completed 的分段数组会整体替换它
    const head = entry.item.summary[0] ?? "";
    const next: CodexStreamEntry = {
      kind: "reasoning",
      item: { ...entry.item, summary: [head + delta, ...entry.item.summary.slice(1)] },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  } else if (frame.type === "commandOutputDelta" && entry.kind === "commandExecution") {
    const next: CodexStreamEntry = {
      kind: "commandExecution",
      item: { ...entry.item, aggregatedOutput: (entry.item.aggregatedOutput ?? "") + delta },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  }
}

/** 5000 条内存护栏：超出后丢最老条目并清理 byId（原 hook 逻辑迁入，语义不变）。 */
function enforceEntryLimit(model: StreamModel): void {
  if (model.entries.length <= MAX_ENTRIES) return;
  const dropped = model.entries.splice(0, model.entries.length - MAX_ENTRIES);
  for (const d of dropped) {
    if (d.item && "id" in d.item && d.item.id) model.byId.delete(d.item.id);
  }
}

/**
 * 把一行帧 JSON 归并进 model（纯函数，无 React/Tauri 依赖）。
 * 非 JSON 行（异常回退的 PTY 字节）与畸形帧静默丢弃。
 */
export function ingestFrameLine(model: StreamModel, lineText: string): void {
  let frame: CodexStreamFrame;
  try {
    frame = JSON.parse(lineText) as CodexStreamFrame;
  } catch {
    return;
  }
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
  applyFrame(model, frame);
  enforceEntryLimit(model);
}
