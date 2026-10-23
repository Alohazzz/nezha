import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  CodexApprovalRequest,
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

// ── 流式归并模型（per-task，参照 useTerminalManager 的 map 模式）──────────────
// 帧到达频率与 PTY 字节同级（每帧一条 delta），必须走 ref 缓冲 + RAF 批量
// setState——终端红线的同款约束（AGENTS.md「高频事件回调中避免 setState」）。
// 条目按 id 归并：item/started 建立条目，delta 追加进流式文本，item/completed
// 用权威快照整体替换。同一时刻可有多个 structured 任务挂载（每项目一个选中
// 任务），模型按 taskId 隔离。

/** agentMessage / plan / reasoning 条目的流式累积形态。 */
type StreamingText =
  | { kind: "agentMessage"; item: CodexAgentMessageItem }
  | { kind: "plan"; item: CodexPlanItem }
  | { kind: "reasoning"; item: CodexReasoningItem };

/** 视图条目：渲染分发的判别形态。 */
export type CodexStreamEntry =
  | { kind: "userMessage"; item: CodexUserMessageItem }
  | { kind: "agentMessage"; item: CodexAgentMessageItem }
  | { kind: "plan"; item: CodexPlanItem }
  | { kind: "reasoning"; item: CodexReasoningItem }
  | { kind: "commandExecution"; item: CodexCommandExecutionItem }
  | { kind: "fileChange"; item: CodexFileChangeItem }
  | { kind: "mcpToolCall"; item: CodexMcpToolCallItem }
  | { kind: "fallback"; item: CodexThreadItem };

interface StreamModel {
  entries: CodexStreamEntry[];
  byId: Map<string, CodexStreamEntry>;
  usage: CodexTokenUsage | null;
}

/** useCodexStream 对外暴露的单任务快照（React state 不可变层）。 */
export interface CodexStreamState {
  entries: CodexStreamEntry[];
  usage: CodexTokenUsage | null;
  approval: CodexApprovalRequest | null;
}

function emptyModel(): StreamModel {
  return { entries: [], byId: new Map(), usage: null };
}

function emptyState(): CodexStreamState {
  return { entries: [], usage: null, approval: null };
}

function classifyItem(item: CodexThreadItem): CodexStreamEntry | null {
  // CodexItemFallback.type 是宽 string，与字面量 case 无法收窄；
  // 按 shape 探测（fallback 是"只有 type + 未知键"的宽松接口）先行排除。
  if (item.type === "userMessage") return { kind: "userMessage", item: item as CodexUserMessageItem };
  if (item.type === "agentMessage") return { kind: "agentMessage", item: item as CodexAgentMessageItem };
  if (item.type === "plan") return { kind: "plan", item: item as CodexPlanItem };
  if (item.type === "reasoning") return { kind: "reasoning", item: item as CodexReasoningItem };
  if (item.type === "commandExecution") return { kind: "commandExecution", item: item as CodexCommandExecutionItem };
  if (item.type === "fileChange") return { kind: "fileChange", item: item as CodexFileChangeItem };
  if (item.type === "mcpToolCall") return { kind: "mcpToolCall", item: item as CodexMcpToolCallItem };
  // 上游新增条目：保留不炸，但不参与视图渲染
  return { kind: "fallback", item };
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
    const entry = classifyItem(item);
    if (!entry) return;
    // completed 是权威快照：已存在则原位替换（保持顺序），否则追加
    const id = entry.item.id;
    const existing = id ? model.byId.get(id) : undefined;
    if (existing) {
      const idx = model.entries.indexOf(existing);
      if (idx >= 0) model.entries[idx] = entry;
    } else {
      model.entries.push(entry);
    }
    if (id) model.byId.set(id, entry);
    return;
  }

  // delta 帧：把增量归并到对应条目。started 帧可能尚未到达（上游乱序兜底），
  // 此时先建一条流式占位条目，completed 帧到达后会被权威快照替换。
  const delta = (frame.payload as { delta?: string }).delta ?? "";
  if (!delta) return;
  const key = frame.itemId || `__delta_${frame.type}`;
  const entry = model.byId.get(key);
  if (!entry) {
    // started 帧没到时先建流式占位条目；commandOutputDelta 的输出无处可挂则丢弃
    const streaming: StreamingText | null =
      frame.type === "agentMessageDelta"
        ? { kind: "agentMessage", item: { type: "agentMessage", id: frame.itemId ?? "", text: delta } }
        : frame.type === "reasoningDelta"
          ? { kind: "reasoning", item: { type: "reasoning", id: frame.itemId ?? "", summary: [delta] } }
          : null;
    if (!streaming) return;
    const created: CodexStreamEntry = streaming;
    model.entries.push(created);
    model.byId.set(key, created);
    return;
  }

  if (frame.type === "agentMessageDelta" && entry.kind === "agentMessage") {
    entry.item.text += delta;
  } else if (frame.type === "reasoningDelta" && entry.kind === "reasoning") {
    // 流式 reasoning 文本放 summary[0]；completed 的分段数组会整体替换它
    if (entry.item.summary.length === 0) entry.item.summary.push("");
    entry.item.summary[0] += delta;
  } else if (frame.type === "commandOutputDelta" && entry.kind === "commandExecution") {
    entry.item.aggregatedOutput = (entry.item.aggregatedOutput ?? "") + delta;
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 5000; // 长任务内存护栏；超出后丢最老的条目
const FLUSH_THROTTLE_MS = 100; // RAF 不可用/被节流时的兜底

/**
 * structured 任务的流式数据管理器（App 级单例，per-task 模型）。
 *
 * - `ingestFrameLine(taskId, line)`：App 层把 structured 任务的 Channel 文本喂进来；
 *   非 JSON 行（异常回退的 PTY 字节）静默丢弃。
 * - `getStream(taskId)`：返回该任务当前快照（未出现过的任务返回空态）。
 * - 审批事件走全局 emit（`codex-approval-requested`），按 taskId 过滤后入库。
 */
export function useCodexStream() {
  const modelsRef = useRef<Map<string, StreamModel>>(new Map());
  const dirtyRef = useRef<Set<string>>(new Set());
  const rafRef = useRef(0);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, CodexStreamState>>({});

  const flush = useCallback(() => {
    rafRef.current = 0;
    if (fallbackTimerRef.current !== null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (dirtyRef.current.size === 0) return;
    const dirty = dirtyRef.current;
    dirtyRef.current = new Set();
    setSnapshot((prev) => {
      let next = prev;
      for (const taskId of dirty) {
        const model = modelsRef.current.get(taskId);
        const state: CodexStreamState = model
          ? { entries: model.entries.slice(), usage: model.usage, approval: prev[taskId]?.approval ?? null }
          : emptyState();
        if (next === prev) next = { ...prev };
        next[taskId] = state;
      }
      return next;
    });
  }, []);

  const scheduleFlush = useCallback(() => {
    if (rafRef.current || fallbackTimerRef.current !== null) return;
    if (typeof requestAnimationFrame === "function") {
      rafRef.current = requestAnimationFrame(flush);
      // RAF 长期不触发的兜底（窗口最小化/后台节流）
      fallbackTimerRef.current = setTimeout(() => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        flush();
      }, FLUSH_THROTTLE_MS);
    } else {
      fallbackTimerRef.current = setTimeout(flush, FLUSH_THROTTLE_MS);
    }
  }, [flush]);

  const ingestFrameLine = useCallback(
    (taskId: string, line: string) => {
      let frame: CodexStreamFrame;
      try {
        frame = JSON.parse(line) as CodexStreamFrame;
      } catch {
        return; // 非 JSON（异常路径的 PTY 回退字节）直接丢弃
      }
      if (!frame || typeof frame !== "object" || typeof frame.type !== "string") return;
      let model = modelsRef.current.get(taskId);
      if (!model) {
        model = emptyModel();
        modelsRef.current.set(taskId, model);
      }
      applyFrame(model, frame);
      if (model.entries.length > MAX_ENTRIES) {
        const dropped = model.entries.splice(0, model.entries.length - MAX_ENTRIES);
        for (const d of dropped) {
          if (d.item && "id" in d.item && d.item.id) model.byId.delete(d.item.id);
        }
      }
      dirtyRef.current.add(taskId);
      scheduleFlush();
    },
    [scheduleFlush],
  );

  // 审批请求是全局 emit 事件（非 Channel），按 taskId 过滤后写进对应任务的状态
  useEffect(() => {
    let mounted = true;
    const p = listen<CodexApprovalRequest>("codex-approval-requested", (e) => {
      if (!mounted) return;
      const taskId = e.payload?.task_id;
      if (!taskId) return;
      const model = modelsRef.current.get(taskId);
      if (!model) {
        // 审批先于任何数据帧到达（罕见）：占一个空模型，让 getStream 能寻址
        modelsRef.current.set(taskId, emptyModel());
      }
      dirtyRef.current.add(taskId);
      setSnapshot((prev) => ({
        ...prev,
        [taskId]: { ...(prev[taskId] ?? emptyState()), approval: e.payload },
      }));
    });
    return () => {
      mounted = false;
      p.then((fn) => fn());
    };
  }, []);

  const setApprovalResolved = useCallback((taskId: string) => {
    setSnapshot((prev) => {
      if (!prev[taskId]) return prev;
      return { ...prev, [taskId]: { ...prev[taskId], approval: null } };
    });
  }, []);

  const resetTask = useCallback((taskId: string) => {
    modelsRef.current.delete(taskId);
    dirtyRef.current.delete(taskId);
    setSnapshot((prev) => {
      if (!prev[taskId]) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  const getStream = useCallback(
    (taskId: string): CodexStreamState => snapshot[taskId] ?? emptyState(),
    [snapshot],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  return { ingestFrameLine, getStream, setApprovalResolved, resetTask };
}
