import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef } from "react";
import type { Task } from "../types";

interface Args {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  persistTasks: (projectId: string, allTasks: Task[]) => void;
  /** 是否启用（e.g. 依赖 Codex CLI 版本提供 session_index.jsonl，关闭开关预留）。 */
  enabled?: boolean;
}

const ACTIVE_POLL_INTERVAL_MS = 45_000;
/** thread_name 只会被 Codex 覆盖更新；拿到一次后任务活跃期内不必反复拉同一值。 */
const NAME_STABLE_SKIP_MS = 20_000;

/** prompt 清洗回退名的截断上限（对齐 Codex TUI 首版 thread_name 的短标题观感）。 */
const PROMPT_NAME_MAX_CHARS = 60;

/** 无 prompt 的任务创建时兜底名为 `task-<id>`，视为「未命名」，允许自动命名覆盖。 */
function isFallbackTaskName(name: string | undefined, taskId: string): boolean {
  return name === undefined || name === `task-${taskId}`;
}

/**
 * 从任务 prompt 清洗出首版任务名（structured 通道的回退数据源）。
 *
 * Codex app-server（structured）会话不写 `session_index.jsonl`，也没有 TUI 的
 * 自动命名——TUI 首版 thread_name 本就是「prompt 清洗截断」，这里做同款推导：
 * 取首行非空文本，剥掉 Markdown 标记与斜杠命令前缀，压成单行后截断。
 */
export function deriveTaskNameFromPrompt(prompt: string | undefined): string | null {
  const firstLine = (prompt ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("<"));
  if (!firstLine) return null;
  const cleaned = firstLine
    // 斜杠命令（如 /model）不是任务主题
    .replace(/^\/\S+\s*/, "")
    // 常见 Markdown 装饰与引用符号
    .replace(/^[>*\-*\d.)\s`]+/, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  const truncated = chars.length > PROMPT_NAME_MAX_CHARS
    ? chars.slice(0, PROMPT_NAME_MAX_CHARS).join("") + "…"
    : cleaned;
  return truncated;
}

/**
 * Codex 任务自动命名：Codex CLI 会把每线程的主题写进 `~/.codex/session_index.jsonl`
 * （首条消息数秒内写入首版，后续轮次用对话内容二次改写得更准）。本 hook 周期性
 * 按任务当前 codexSessionId 查询该文件，把 `thread_name` 写回 `task.name`。
 *
 * 覆盖规则：只覆盖「自动来源」的名字——`task-${id}` 兜底名或上次由本 hook 写入的值；
 * 用户在 nezha 里手动改过的名字（或 ✨ 生成的名字）绝不覆盖，用 appliedNamesRef 记账。
 */
export function useCodexAutoName({ tasks, setTasks, persistTasks, enabled = true }: Args) {
  const tasksRef = useRef(tasks);
  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  // taskId -> 本 hook 最后一次写入的名字；用于区分「自动名」和「用户/✨ 名」。
  const appliedNamesRef = useRef<Map<string, string>>(new Map());
  // taskId -> 上次查询时刻，避免活跃任务高频轮询时反复 invoke。
  const lastCheckedAtRef = useRef<Map<string, number>>(new Map());
  const inFlightRef = useRef<Set<string>>(new Set());

  const refreshTask = useCallback(
    (task: Task, force = false) => {
      if (!enabled) return;
      if (task.agent !== "codex") return;
      const sessionId = task.codexSessionId;
      if (!sessionId) return;
      // 只覆盖「未命名 / 兜底名 / 本 hook 写过的自动名」；用户手动或 ✨ 生成名绝不覆盖。
      const applied = appliedNamesRef.current.get(task.id);
      if (!isFallbackTaskName(task.name, task.id) && task.name !== applied) return;
      const lastChecked = lastCheckedAtRef.current.get(task.id) ?? 0;
      if (!force && Date.now() - lastChecked < NAME_STABLE_SKIP_MS) return;
      if (inFlightRef.current.has(task.id)) return;

      inFlightRef.current.add(task.id);
      lastCheckedAtRef.current.set(task.id, Date.now());
      invoke<string | null>("get_codex_thread_name", { sessionId })
        .then((name) => {
          // structured（app-server）会话不写 session_index.jsonl，索引查不到时
          // 回退 prompt 清洗——与 TUI 首版 thread_name 同源，保证任务不再停在
          // `task-<id>` 兜底名。PTY 会话索引命中则用 Codex 自己的名字。
          const trimmed = (name ?? "").trim() || deriveTaskNameFromPrompt(task.prompt) || "";
          if (!trimmed) return;
          setTasks((prev) => {
            const current = prev.find((t) => t.id === task.id);
            if (!current || current.agent !== "codex") return prev;
            // await 期间名字仍须是「可覆盖」状态（未命名 / 兜底名 / 本 hook 写过的
            // 自动名），用户改过或 ✨ 生成过 → 放弃，保护用户输入。
            if (!isFallbackTaskName(current.name, current.id)) {
              const currentApplied = appliedNamesRef.current.get(current.id);
              if (current.name !== currentApplied) return prev;
            }
            if (current.name === trimmed) return prev;
            const next = prev.map((t) =>
              t.id === task.id ? { ...t, name: trimmed } : t,
            );
            persistTasks(task.projectId, next);
            return next;
          });
          // 必须在 setTasks **之后**记账：updater 是异步执行的，先记账会让守卫把
          // 自己刚要写入的名字误判成「用户手改名」而丢弃（本次修复的 bug）。
          appliedNamesRef.current.set(task.id, trimmed);
        })
        .catch((e: unknown) => {
          // 文件缺失/读失败是常态（老版本 Codex CLI 无 session_index.jsonl），静默即可。
          void e;
        })        .finally(() => {
          inFlightRef.current.delete(task.id);
        });
    },
    [enabled, persistTasks, setTasks],
  );

  // 会话发现 / 状态变化 → 立即查一次（force 跳过节流，首名要快）。
  // 对已结束（done/failed/cancelled…）的 Codex 任务同样生效：首次见到就补一次名，
  // 之后不再轮询——结束态名字已定稿，查这一次足够。
  useEffect(() => {
    for (const task of tasks) {
      if (task.agent !== "codex" || !task.codexSessionId) continue;
      const applied = appliedNamesRef.current.get(task.id);
      if (!isFallbackTaskName(task.name, task.id) && task.name !== applied) continue;
      if (!lastCheckedAtRef.current.has(task.id)) {
        refreshTask(task, true);
      }
    }
  }, [tasks, refreshTask]);

  // 活跃任务轮询：Codex 会随轮次把名字改写得更准（实测有开跑 24 分钟后才定稿的）。
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      for (const task of tasksRef.current) {
        if (
          task.agent === "codex" &&
          task.codexSessionId &&
          (task.status === "running" ||
            task.status === "pending" ||
            task.status === "input_required" ||
            task.status === "awaiting_review")
        ) {
          refreshTask(task);
        }
      }
    }, ACTIVE_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refreshTask]);
}
