import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CodexApprovalRequest,
  CodexStreamFrame,
  CodexTokenUsage,
  CodexUserInputRequest,
  CodexUserMessageItem,
} from "../types";
import {
  createStreamModel,
  finalizeInterruptedEntries,
  ingestFrame,
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
  /** 模型提问（`request_user_input` 工具），与审批互斥地占用底部卡片区。 */
  userInput: CodexUserInputRequest | null;
  /** 从 rollout 会话文件回放历史的状态（实时帧到达后不再尝试）。 */
  history: CodexHistoryStatus;
}

/** 历史回放（从 rollout 会话文件水合）的状态机。
 *  `idle` 尚未尝试 / 已放弃（如任务仍在跑，实时帧才是权威）；
 *  `loading` 正在读文件；`ready` 已灌入；`failed` 读取失败（保留 reason 供视图提示）。 */
export type CodexHistoryStatus =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; entryCount: number }
  | { state: "failed"; reason: string };

/** 快照里的历史回放状态：视图据此区分「还没加载」与「真的没有记录」。 */
const IDLE_HISTORY: CodexHistoryStatus = { state: "idle" };

// 视图层（CodexStreamView 等）从此处导入条目类型；定义已上移纯函数层
export type { CodexStreamEntry } from "./codexStreamMerge";

function emptyState(): CodexStreamState {
  return { entries: [], usage: null, approval: null, userInput: null, history: IDLE_HISTORY };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const FLUSH_THROTTLE_MS = 100; // RAF 不可用/被节流时的兜底

/**
 * structured 任务的流式数据管理器（App 级单例，per-task 模型）。
 *
 * - `ingestFrameLine(taskId, line)`：App 层把 structured 任务的 Channel 文本喂进来；
 *   非 JSON 行（异常回退的 PTY 字节）静默丢弃（归并层兜底）。
 * - `getStream(taskId)`：返回该任务当前快照（未出现过的任务返回空态）。
 * - `hydrateHistory(taskId, sessionPath, projectPath?)`：条目为空时从 rollout
 *   会话文件回放历史（projectPath 缺省用 hook 参数）。
 * - 审批事件走全局 emit（`codex-approval-requested`），按 taskId 过滤后入库。
 *
 * @param projectPath 当前激活项目的根路径：历史回放要经后端的会话根校验，
 *   校验需要项目路径（Codex 会话可能落在项目内 `.codex/sessions`）。
 */
export function useCodexStream(projectPath?: string) {
  const modelsRef = useRef<Map<string, StreamModel>>(new Map());
  const dirtyRef = useRef<Set<string>>(new Set());
  const rafRef = useRef(0);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在回放的任务（防止视图重渲染触发并发读盘）。 */
  const pendingRef = useRef<Set<string>>(new Set());
  /** `taskId|sessionPath` → 已尝试回放（成功或失败都记）。失败不自动重试：
   *  否则「读盘失败 → 状态变化 → effect 再触发」会打成死循环。 */
  const attemptedRef = useRef<Set<string>>(new Set());
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
          ? {
              entries: model.entries.slice(),
              usage: model.usage,
              approval: prev[taskId]?.approval ?? null,
              userInput: prev[taskId]?.userInput ?? null,
              history: prev[taskId]?.history ?? IDLE_HISTORY,
            }
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

  // 模型提问与审批是两条独立的全局事件，各自入库到同一任务的快照。
  // 同时挂起时卡片区只渲染提问（提问会阻塞 turn，比审批更紧急）；
  // 两者都清掉后 composer 才恢复可输入。
  useEffect(() => {
    let mounted = true;
    const p = listen<CodexUserInputRequest>("codex-user-input-requested", (e) => {
      if (!mounted) return;
      const taskId = e.payload?.task_id;
      if (!taskId) return;
      if (!modelsRef.current.get(taskId)) {
        modelsRef.current.set(taskId, createStreamModel());
      }
      setSnapshot((prev) => ({
        ...prev,
        [taskId]: { ...(prev[taskId] ?? emptyState()), userInput: e.payload },
      }));
    });
    return () => {
      mounted = false;
      p.then((fn) => fn());
    };
  }, []);

  const setUserInputResolved = useCallback((taskId: string) => {
    setSnapshot((prev) => {
      if (!prev[taskId]) return prev;
      return { ...prev, [taskId]: { ...prev[taskId], userInput: null } };
    });
  }, []);

  // full_access 下 30s 无人应答，后端已按推荐项自动应答：撤掉问答卡片，恢复
  // composer。request_id 比对防止误清新提问（auto-answered 只可能对应旧请求）。
  useEffect(() => {
    let mounted = true;
    const p = listen<{ task_id: string; request_id: number }>(
      "codex-user-input-auto-answered",
      (e) => {
        if (!mounted) return;
        const { task_id: taskId, request_id: requestId } = e.payload ?? {};
        if (!taskId) return;
        setSnapshot((prev) => {
          const state = prev[taskId];
          if (!state || state.userInput?.request_id !== requestId) return prev;
          return { ...prev, [taskId]: { ...state, userInput: null } };
        });
      },
    );
    return () => {
      mounted = false;
      p.then((fn) => fn());
    };
  }, []);

  const resetTask = useCallback((taskId: string) => {
    modelsRef.current.delete(taskId);
    dirtyRef.current.delete(taskId);
    // 重跑任务会生成新会话路径：清掉该任务的全部回放记录，让新历史能重新回放。
    // 记录键是 `taskId|sessionPath`，必须按前缀清而不是按 taskId 精确删。
    const prefix = `${taskId}|`;
    for (const key of attemptedRef.current) {
      if (key.startsWith(prefix)) attemptedRef.current.delete(key);
    }
    pendingRef.current.delete(taskId);
    setSnapshot((prev) => {
      if (!prev[taskId]) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  }, []);

  // 任务终态收口（interrupted / failed / cancelled / done）：归并层纯函数把仍在
  // 途的条目（endedAtMs 为 null）全部落终态——被终止的任务不会再有上游 completed
  // 帧，不收口的话命令聚合组永远显示「正在执行」、动态计时永远走秒。
  const finalizeTask = useCallback(
    (taskId: string) => {
      const model = modelsRef.current.get(taskId);
      if (!model) return;
      finalizeInterruptedEntries(model, Date.now());
      dirtyRef.current.add(taskId);
      scheduleFlush();
    },
    [scheduleFlush],
  );

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
      return { ...prev, [taskId]: { ...prev[taskId], approval: null, userInput: null } };
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

  // ── 历史回放水合（历史任务重开后恢复会话视图）──────────────────────────────
  // structured 条目只活在内存模型里：重开应用 / 打开已完成的历史任务时模型为空，
  // 视图只能显示「没有智能体活动记录」。这里在条目为空时读一次 rollout 会话文件，
  // 把后端转换好的流帧灌进同一个 model，渲染链路与实时完全一致。
  //
  // 竞态保护：
  // - 同一 (taskId, sessionPath) 只尝试一次，失败也不自动重试（否则「失败 →
  //   状态变化 → effect 再触发」会打成死循环）；
  // - 回放期间若已有实时帧到达（model.entries 非空），放弃回放结果——实时帧
  //   才是权威，回放会让同一轮内容重复；
  // - resetTask 会清掉记录（重跑任务需要重新回放新一轮）。
  const hydrateHistory = useCallback(
    async (taskId: string, sessionPath: string, taskProjectPath?: string) => {
      if (!taskId || !sessionPath) return;
      const key = `${taskId}|${sessionPath}`;
      if (attemptedRef.current.has(key)) return;
      // 同任务并发调用（视图重渲染）只放行一次。
      if (pendingRef.current.has(taskId)) return;
      attemptedRef.current.add(key);
      pendingRef.current.add(taskId);

      const setHistory = (history: CodexHistoryStatus) => {
        setSnapshot((prev) => {
          const current = prev[taskId] ?? emptyState();
          if (current.history === history) return prev;
          return { ...prev, [taskId]: { ...current, history } };
        });
      };
      setHistory({ state: "loading" });

      try {
        const result = await invoke<{ frames: CodexStreamFrame[] }>(
          "read_codex_stream_history",
          { sessionPath, projectPath: taskProjectPath || projectPath || "", taskId },
        );
        const current = modelsRef.current.get(taskId);
        // 实时帧已经落地（任务正在跑 / 刚续跑）：回放会与实时内容重复，直接放弃。
        if (current && current.entries.length > 0) {
          setHistory({ state: "idle" });
          return;
        }
        const model = current ?? createStreamModel();
        modelsRef.current.set(taskId, model);
        for (const frame of result.frames ?? []) ingestFrame(model, frame);
        dirtyRef.current.add(taskId);
        scheduleFlush();
        setHistory({ state: "ready", entryCount: model.entries.length });
      } catch (err) {
        const message = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
        setHistory({ state: "failed", reason: message });
      } finally {
        pendingRef.current.delete(taskId);
      }
    },
    [projectPath, scheduleFlush],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (fallbackTimerRef.current !== null) clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  return {
    ingestFrameLine: ingest,
    getStream,
    setApprovalResolved,
    setUserInputResolved,
    resetTask,
    finalizeTask,
    beginFollowUpRound,
    appendLocalUserMessage,
    hydrateHistory,
  };
}
