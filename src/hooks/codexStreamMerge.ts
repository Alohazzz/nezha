import type {
  CodexAgentMessageItem,
  CodexCollabAgentToolCallItem,
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

/** 视图条目：渲染分发的判别形态。revision 见模块头注释。
 * 时间字段（issue #119）：startedAtMs / endedAtMs 为毫秒时间戳（内存态，不落盘）。
 * 后端帧 tsMs 优先；缺失（乱序占位 / resume 回放）时以本地时钟兜底。
 * endedAtMs 为 null = 条目尚未完成（reasoning 卡据此判定 running 态）。 */
export type CodexStreamEntry =
  | { kind: "userMessage"; item: CodexUserMessageItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "agentMessage"; item: CodexAgentMessageItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "plan"; item: CodexPlanItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "reasoning"; item: CodexReasoningItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "commandExecution"; item: CodexCommandExecutionItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "fileChange"; item: CodexFileChangeItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "mcpToolCall"; item: CodexMcpToolCallItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "collabAgentToolCall"; item: CodexCollabAgentToolCallItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "fallback"; item: CodexThreadItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null };

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
  if (item.type === "userMessage") return { kind: "userMessage", item: item as CodexUserMessageItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "agentMessage") return { kind: "agentMessage", item: item as CodexAgentMessageItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "plan") return { kind: "plan", item: item as CodexPlanItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "reasoning") return { kind: "reasoning", item: item as CodexReasoningItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "commandExecution")
    return { kind: "commandExecution", item: item as CodexCommandExecutionItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "fileChange") return { kind: "fileChange", item: item as CodexFileChangeItem, revision: 0, startedAtMs: null, endedAtMs: null };
  if (item.type === "mcpToolCall") return { kind: "mcpToolCall", item: item as CodexMcpToolCallItem, revision: 0, startedAtMs: null, endedAtMs: null };
  // 多智能体协作调用（spawnAgent / wait / sendInput 等）：上游正式条目类型，
  // 曾经因未注册渲染器落到 fallback 原始 JSON 卡，被误读成报错（wait 超时尤其像）。
  if (item.type === "collabAgentToolCall")
    return {
      kind: "collabAgentToolCall",
      item: item as CodexCollabAgentToolCallItem,
      revision: 0,
      startedAtMs: null,
      endedAtMs: null,
    };
  // 上游新增条目：保留不炸，但不参与视图渲染
  return { kind: "fallback", item, revision: 0, startedAtMs: null, endedAtMs: null };
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

/**
 * 上游 userMessage 条目落地前，剔除尾部内容相同的本地乐观气泡（`__local_` 前缀）。
 * resume 通道会重放刚写入 thread 的 UserMessage 帧，与 App 层的乐观回显撞成
 * 两条一模一样的气泡；按内容匹配去重，保留上游权威条目。
 */
function dropTailingLocalEcho(model: StreamModel, text: string): void {
  for (let i = model.entries.length - 1; i >= 0; i -= 1) {
    const entry = model.entries[i];
    if (entry.kind !== "userMessage") break;
    const id = entry.item.id ?? "";
    if (!id.startsWith("__local_")) break;
    const localText = entry.item.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("");
    if (localText === text) {
      model.entries.splice(i, 1);
      model.byId.delete(id);
    }
    break;
  }
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
    if (item.type === "userMessage") {
      dropTailingLocalEcho(
        model,
        (item as CodexUserMessageItem).content
          .map((c) => ("text" in c ? c.text : ""))
          .join(""),
      );
    }
    // 时间戳归并（issue #119）：帧 tsMs 优先（后端信封透传），缺失时本地时钟
    // 兜底（占位/乱序/resume 回放场景——resume 重放可能只有 completed 帧）。
    // completed 权威快照替换流式占位条目时必须沿用 existing 的 startedAtMs，
    // 否则思考/命令卡的动态计时起点被冲掉。
    const entry = classifyItem(item);
    const existing = item.id ? model.byId.get(item.id) : undefined;
    const frameTs = frame.tsMs;
    if (frame.phase === "started") {
      entry.startedAtMs = frameTs ?? Date.now();
      entry.endedAtMs = null;
    } else if (frame.phase === "completed") {
      entry.startedAtMs = existing?.startedAtMs ?? frameTs ?? Date.now();
      entry.endedAtMs = frameTs ?? Date.now();
    }
    replaceEntry(model, entry);
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
    if (streaming) {
      // 占位条目以本地时钟记起点（#119）：乱序场景下 started 帧迟到会经权威
      // 替换沿用此值；动态计时组件据此起跳。
      const created: CodexStreamEntry = { ...streaming, revision: 0, startedAtMs: Date.now(), endedAtMs: null };
      model.entries.push(created);
      model.byId.set(key, created);
      return;
    }
    // fileChangeDelta 乱序占位：path 未知的占位 change 承载累积 diff（渲染端
    // 走纯文本兜底）；同款本地时钟起点，completed 权威快照整体替换。
    if (frame.type === "fileChangeDelta") {
      const created: CodexStreamEntry = {
        kind: "fileChange",
        item: {
          type: "fileChange",
          id: frame.itemId ?? "",
          changes: [{ path: "", kind: { type: "update", movePath: null }, diff: delta }],
          status: "inProgress",
        },
        revision: 0,
        startedAtMs: Date.now(),
        endedAtMs: null,
      };
      model.entries.push(created);
      model.byId.set(key, created);
    }
    return;
  }

  if (frame.type === "agentMessageDelta" && entry.kind === "agentMessage") {
    // 条目级展开：时间字段（startedAtMs/endedAtMs）与 revision 外的全部
    // entry 元数据随 {...entry} 原样携带，各分支只改 item 与 revision。
    const next: CodexStreamEntry = {
      ...entry,
      item: { ...entry.item, text: entry.item.text + delta },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  } else if (frame.type === "reasoningDelta" && entry.kind === "reasoning") {
    // 流式 reasoning 文本放 summary[0]；completed 的分段数组会整体替换它
    const head = entry.item.summary[0] ?? "";
    const next: CodexStreamEntry = {
      ...entry,
      item: { ...entry.item, summary: [head + delta, ...entry.item.summary.slice(1)] },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  } else if (frame.type === "commandOutputDelta" && entry.kind === "commandExecution") {
    const next: CodexStreamEntry = {
      ...entry,
      item: { ...entry.item, aggregatedOutput: (entry.item.aggregatedOutput ?? "") + delta },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  } else if (frame.type === "fileChangeDelta" && entry.kind === "fileChange") {
    // 编辑 diff 增量：delta 是该条目 diff 文本的顺序片段，追加到首个 change 的
    // diff 上（changes 为空时建 path 未知的占位 change——渲染端按纯文本兜底解析
    // 拼接形态）。completed 的权威 changes 快照会整体替换流式累积。
    const changes = entry.item.changes.slice();
    if (changes.length === 0) {
      changes.push({ path: "", kind: { type: "update", movePath: null }, diff: delta });
    } else {
      changes[0] = { ...changes[0], diff: (changes[0]?.diff ?? "") + delta };
    }
    const next: CodexStreamEntry = {
      ...entry,
      item: { ...entry.item, changes },
      revision: entry.revision + 1,
    };
    replaceEntry(model, next);
  }
}

/** 5000 条内存护栏：超出后丢最老条目并清理 byId。占位条目（id 为空的流式
 * __delta_* 条目）也要按插入时的身份键清掉，否则 byId 残留泄漏。 */
function enforceEntryLimit(model: StreamModel): void {
  if (model.entries.length <= MAX_ENTRIES) return;
  const dropped = model.entries.splice(0, model.entries.length - MAX_ENTRIES);
  for (const d of dropped) {
    const id = d.item && "id" in d.item ? d.item.id : undefined;
    if (id) {
      model.byId.delete(id);
    } else {
      // 无 id 的占位条目：只有 agentMessage / reasoning 两种 delta 占位，
      // 按 applyFrame 的 `__delta_<type>` 键同步清理（commandOutputDelta 占位
      // 从不建条目，无须处理）
      model.byId.delete("__delta_agentMessageDelta");
      model.byId.delete("__delta_reasoningDelta");
    }
  }
}

/** 帧时间戳运行时校验（#119）：非有限数视为缺失（畸形帧容错，与帧解析的
 * 宽容语义一致）。 */
function validTs(ts: number | undefined): number | undefined {
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
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
  if (frame.tsMs !== undefined) frame.tsMs = validTs(frame.tsMs);
  applyFrame(model, frame);
  enforceEntryLimit(model);
}
