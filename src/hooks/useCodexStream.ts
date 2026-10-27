import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  CodexApprovalRequest,
  CodexTokenUsage,
  CodexUserMessageItem,
} from "../types";
import {
  createStreamModel,
  ingestFrameLine,
  type CodexStreamEntry,
  type StreamModel,
} from "./codexStreamMerge";

// ── 流式归并 hook（per-task，参照 useTerminalManager 的 map 模式）─────────────
// 帧到达频率与 PTY 字节同级（每帧一条 delta），必须走 ref 缓冲 + RAF 批量
// setState——终端红线的同款约束（AGENTS.md「高频事件回调中避免 setState」）。
//
// 帧 JSON → model 的归并语义抽在 ./codexStreamMerge（纯函数层，issue #117 T1）：
// delta 追加生成新条目对象（不可变替换）并携带递增 revision，memo 化的下游卡片
// 靠引用比较即可观察到每次增量。本 hook 只剩接线：ref buffer + RAF 批量 flush +
// 快照提升。同一时刻可有多个 structured 任务挂载（每项目一个选中任务），模型按
// taskId 隔离。

/** useCodexStream 对外暴露的单任务快照（React state 不可变层）。 */
export interface CodexStreamState {
  entries: CodexStreamEntry[];
  usage: CodexTokenUsage | null;
  approval: CodexApprovalRequest | null;
}

// 视图层（CodexStreamView 等）从此处导入条目类型；定义已上移纯函数层
export type { CodexStreamEntry } from "./codexStreamMerge";

function emptyState(): CodexStreamState {
  return { entries: [], usage: null, approval: null };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const FLUSH_THROTTLE_MS = 100; // RAF 不可用/被节流时的兜底

/**
 * structured 任务的流式数据管理器（App 级单例，per-task 模型）。
 *
 * - `ingestFrameLine(taskId, line)`：App 层把 structured 任务的 Channel 文本喂进来；
 *   非 JSON 行（异常回退的 PTY 字节）静默丢弃（归并层兜底）。
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

  const ingest = useCallback(
    (taskId: string, lineText: string) => {
      let model = modelsRef.current.get(taskId);
      if (!model) {
        model = createStreamModel();
        modelsRef.current.set(taskId, model);
      }
      ingestFrameLine(model, lineText);
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
        modelsRef.current.set(taskId, createStreamModel());
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

  // done 后继续对话（resume 通道）的开轮动作：清上一轮 usage/审批残留，但**保留
  // entries**——thread/resume 不会把历史 item 重放回 Channel（forwarder 又是
  // resume 之后才 subscribe），前端内存流是历史的唯一载体，reset 会让整个会话
  // 视图清空只剩新一轮内容。新一轮 item id 由上游新生成，追加归并不冲突。
  const beginFollowUpRound = useCallback((taskId: string) => {
    const model = modelsRef.current.get(taskId);
    if (model) {
      model.usage = null;
      dirtyRef.current.add(taskId);
      scheduleFlush();
    }
    setSnapshot((prev) => {
      if (!prev[taskId]) return prev;
      return { ...prev, [taskId]: { ...prev[taskId], approval: null } };
    });
  }, [scheduleFlush]);

  // 乐观用户气泡（Paseo 式 composer 的本地回显）：composer 提交后立即插入，
  // 不等上游 item/userMessage 帧——resume 通道重放时上游帧会带来权威条目，
  // 与本条共存可接受（id 不同），steer 通道上游不回显用户文本，本条是唯一显示。
  // images 非空时 content 混入 localImage 项（dataUrl 直渲，issue #118）。
  const appendLocalUserMessage = useCallback(
    (taskId: string, text: string, images: string[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && images.length === 0) return;
      let model = modelsRef.current.get(taskId);
      if (!model) {
        model = createStreamModel();
        modelsRef.current.set(taskId, model);
      }
      const content: CodexUserMessageItem["content"] = [];
      if (trimmed) content.push({ type: "text", text: trimmed });
      for (const dataUrl of images) {
        content.push({ type: "localImage", url: dataUrl });
      }
      const entry: CodexStreamEntry = {
        kind: "userMessage",
        revision: 0,
        item: { type: "userMessage", id: `__local_${Date.now()}`, content },
      };
      model.entries.push(entry);
      if (entry.item.id) model.byId.set(entry.item.id, entry);
      dirtyRef.current.add(taskId);
      scheduleFlush();
    },
    [scheduleFlush],
  );

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

  return { ingestFrameLine: ingest, getStream, setApprovalResolved, resetTask, beginFollowUpRound, appendLocalUserMessage };
}
