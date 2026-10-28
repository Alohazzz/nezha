import type {
  CodexAgentMessageItem,
  CodexCollabAgentToolCallItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexImageViewItem,
  CodexMcpToolCallItem,
  CodexPlanItem,
  CodexReasoningItem,
  CodexStreamFrame,
  CodexSubAgentActivityItem,
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
  | { kind: "imageView"; item: CodexImageViewItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "reasoning"; item: CodexReasoningItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "commandExecution"; item: CodexCommandExecutionItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "fileChange"; item: CodexFileChangeItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "mcpToolCall"; item: CodexMcpToolCallItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "collabAgentToolCall"; item: CodexCollabAgentToolCallItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
  | { kind: "subAgentActivity"; item: CodexSubAgentActivityItem; revision: number; startedAtMs?: number | null; endedAtMs?: number | null }
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
  // 图片查看（`view_image` 工具）：上游正式条目，只有 id + path。不注册就会落进
  // 兜底 JSON 卡——用户看到的是 `{id, path, type}` 三个字段，而图本身看不到。
  if (item.type === "imageView") return { kind: "imageView", item: item as CodexImageViewItem, revision: 0, startedAtMs: null, endedAtMs: null };
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
  // 子智能体生命周期活动（上游 subAgentActivity：started / completed / interrupted）：
  // 与 collabAgentToolCall 同源但语义不同——那条是父智能体的调度动作，这条是子智能体
  // 自身的状态进展。不注册就会落进兜底卡只显示原始 JSON，用户看不出子智能体是否已结束。
  if (item.type === "subAgentActivity")
    return {
      kind: "subAgentActivity",
      item: item as CodexSubAgentActivityItem,
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

/** 上游 kind 的终态判定：只有这两个之后不再有该智能体的后续活动。 */
function isTerminalSubAgentKind(kind: string): boolean {
  return kind === "completed" || kind === "interrupted";
}

/**
 * 子智能体生命周期事件归并（`ThreadItem::SubAgentActivity`）。
 *
 * 与其它条目最大的不同：**不能按 item.id 归并**。上游每个活动事件都带新 id
 * （started 是 `spawn-<child>`、completed 是 `<child>-turn-completed`，见
 * app-server-protocol/thread_history 的用例），按 id 收就会把同一个子智能体
 * 拆成两行——一行永远停在「运行中」，一行「已完成」，正是「不知道结束没结束」
 * 的另一个来源。这里改为按 `agentThreadId` 聚合成一张卡，后到的事件覆盖状态，
 * 卡片 id 固定用首个事件的 id（展开态才能跨状态切换保持）。
 *
 * `interacted` 直接丢弃：上游 TUI 也不把它单独成行（multi_agents.rs::
 * sub_agent_activity_display 返回 None），每次都渲染会把起止信号淹没。
 */
function applySubAgentActivity(
  model: StreamModel,
  item: CodexSubAgentActivityItem,
  frameTs: number | undefined,
): void {
  if (item.kind === "interacted") return;
  const agentKey = item.agentThreadId || item.id;
  if (!agentKey) return;

  // 用带前缀的键避开与普通条目 id 的命名空间冲突（子智能体线程 id 也可能
  // 以别的形态出现在 byId 里）。
  const indexKey = `__subagent_${agentKey}`;
  const existing = model.byId.get(indexKey);
  const ts = frameTs ?? Date.now();

  if (!existing) {
    const created: CodexStreamEntry = {
      kind: "subAgentActivity",
      // 卡片 id 用首个事件 id：后续事件 id 会变，换 id 会重建卡片丢展开态。
      item: { ...item },
      revision: 0,
      startedAtMs: ts,
      endedAtMs: isTerminalSubAgentKind(item.kind) ? ts : null,
    };
    model.entries.push(created);
    model.byId.set(indexKey, created);
    if (created.item.id) model.byId.set(created.item.id, created);
    return;
  }

  if (existing.kind !== "subAgentActivity") return;
  // 后到事件覆盖 kind / model / path（completed 事件通常不带 model，
  // 沿用已有的，避免把已知信息冲成空）。
  const merged: CodexStreamEntry = {
    ...existing,
    item: {
      ...existing.item,
      kind: item.kind,
      agentPath: item.agentPath || existing.item.agentPath,
      agentThreadId: item.agentThreadId || existing.item.agentThreadId,
      model: item.model ?? existing.item.model ?? null,
      reasoningEffort: item.reasoningEffort ?? existing.item.reasoningEffort ?? null,
    },
    revision: existing.revision + 1,
    endedAtMs: isTerminalSubAgentKind(item.kind) ? ts : existing.endedAtMs,
  };
  const idx = model.entries.indexOf(existing);
  if (idx >= 0) model.entries[idx] = merged;
  model.byId.set(indexKey, merged);
  if (merged.item.id) model.byId.set(merged.item.id, merged);
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
    // 子智能体生命周期事件单独归并（见 applySubAgentActivity 注释）。
    if (item.type === "subAgentActivity") {
      applySubAgentActivity(model, item as CodexSubAgentActivityItem, frame.tsMs);
      return;
    }
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
      entry.startedAtMs = frame.startedTsMs ?? frameTs ?? Date.now();
      entry.endedAtMs = null;
    } else if (frame.phase === "completed") {
      // 历史回放帧（read_codex_stream_history）只落完成时刻，起点由后端按 turn
      // 起始推算后经 startedTsMs 下发——优先采用，否则折叠头会按「打开页面
      // 的那一刻」起算，历史轮次全都显示成 0 秒。
      entry.startedAtMs =
        existing?.startedAtMs ?? frame.startedTsMs ?? frameTs ?? Date.now();
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
 * __delta_* 条目）与子智能体聚合条目（`__subagent_<threadId>` 额外索引）也要
 * 按各自的键清掉，否则 byId 残留泄漏。 */
function enforceEntryLimit(model: StreamModel): void {
  if (model.entries.length <= MAX_ENTRIES) return;
  const dropped = model.entries.splice(0, model.entries.length - MAX_ENTRIES);
  for (const d of dropped) {
    const id = d.item && "id" in d.item ? d.item.id : undefined;
    if (id) {
      model.byId.delete(id);
      // 子智能体条目还额外挂了聚合键，必须一并清（否则 byId 里留下永久孤儿，
      // 让同一 threadId 的后续事件命中已被淘汰的条目）。
      if (d.kind === "subAgentActivity") {
        model.byId.delete(`__subagent_${d.item.agentThreadId || d.item.id}`);
      }
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
  ingestFrame(model, frame);
}

/**
 * 把已解析的帧对象归并进 model。历史回放（`read_codex_stream_history`）返回
 * 的就是解析后的对象数组，走这里省掉一次 stringify/parse；实时 Channel 仍
 * 走 `ingestFrameLine`。
 */
export function ingestFrame(model: StreamModel, frame: CodexStreamFrame): void {
  if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
  if (frame.tsMs !== undefined) frame.tsMs = validTs(frame.tsMs);
  if (frame.startedTsMs !== undefined) frame.startedTsMs = validTs(frame.startedTsMs);
  applyFrame(model, frame);
  enforceEntryLimit(model);
}
