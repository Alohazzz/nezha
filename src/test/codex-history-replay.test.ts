import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useCodexStream } from "../hooks/useCodexStream";

// 历史回放回归：structured 任务的条目只活在内存模型里，重开应用 / 打开已完成的
// 历史任务时模型为空，流视图只能显示「没有智能体活动记录」。hydrateHistory 从
// rollout 会话文件读回后端转换好的流帧，灌进同一个 model。

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

const BASE = { taskId: "task-1", threadId: "thread-1", turnId: "turn-1" };

function frame(payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...BASE, type: "item", phase: "completed", tsMs: 1_700_000_000_000, payload, ...extra };
}

async function flushStream(assertion: () => void, timeout = 2000): Promise<void> {
  await waitFor(assertion, { timeout, interval: 50 });
}

describe("useCodexStream 历史回放（历史任务打开后恢复会话视图）", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("hydrates entries and usage from a rollout session file", async () => {
    invokeMock.mockResolvedValueOnce({
      frames: [
        frame(
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "hello" }] },
          { startedTsMs: 1_700_000_000_000 },
        ),
        frame({ type: "agentMessage", id: "a1", text: "hi there" }, { startedTsMs: 1_700_000_001_000 }),
        {
          ...BASE,
          type: "tokenUsage",
          phase: "updated",
          payload: {
            total: { totalTokens: 10 },
            last: { totalTokens: 5 },
            modelContextWindow: 1000,
          },
        },
      ],
    });

    const { result } = renderHook(() => useCodexStream());

    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/rollout-a.jsonl", "/proj");
    });

    expect(invokeMock).toHaveBeenCalledWith("read_codex_stream_history", {
      sessionPath: "/sessions/rollout-a.jsonl",
      projectPath: "/proj",
      taskId: "task-1",
    });

    await flushStream(() => {
      expect(result.current.getStream("task-1").entries).toHaveLength(2);
    });
    const state = result.current.getStream("task-1");
    expect(state.entries.map((e) => e.kind)).toEqual(["userMessage", "agentMessage"]);
    expect(state.usage?.total.totalTokens).toBe(10);
    expect(state.history).toEqual({ state: "ready", entryCount: 2 });
  });

  it("keeps replayed start timestamps so turn durations are real", async () => {
    const started = 1_700_000_000_000;
    invokeMock.mockResolvedValueOnce({
      frames: [
        frame(
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "go" }] },
          { startedTsMs: started },
        ),
        frame(
          {
            type: "commandExecution",
            id: "c1",
            command: "echo hi",
            cwd: "/proj",
            status: "completed",
            aggregatedOutput: "hi",
            exitCode: 0,
            durationMs: 1200,
          },
          { startedTsMs: started + 5_000, tsMs: started + 6_200 },
        ),
      ],
    });

    const { result } = renderHook(() => useCodexStream());
    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/rollout-b.jsonl", "/proj");
    });
    await flushStream(() => {
      expect(result.current.getStream("task-1").entries).toHaveLength(2);
    });

    const command = result.current.getStream("task-1").entries[1];
    // 折叠头靠这两个字段算「已工作 X 秒」：回放帧必须带上后端推算的起点，
    // 否则历史轮次会按「打开页面的那一刻」起算，时长全是 0。
    expect(command.startedAtMs).toBe(started + 5_000);
    expect(command.endedAtMs).toBe(started + 6_200);
  });

  it("does not replay twice for the same task and session path", async () => {
    invokeMock.mockResolvedValue({ frames: [frame({ type: "agentMessage", id: "a1", text: "x" })] });
    const { result } = renderHook(() => useCodexStream());

    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/rollout-c.jsonl", "/proj");
      await result.current.hydrateHistory("task-1", "/sessions/rollout-c.jsonl", "/proj");
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("keeps live entries when frames already arrived before replay resolves", async () => {
    let resolveHistory: (value: unknown) => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
    );

    const { result } = renderHook(() => useCodexStream());
    const pending = result.current.hydrateHistory("task-1", "/sessions/rollout-d.jsonl", "/proj");

    // 回放还在读盘时实时帧先到（任务正在跑）：实时帧才是权威，回放必须让位，
    // 否则同一轮内容会被渲染两遍。
    act(() => {
      result.current.ingestFrameLine(
        "task-1",
        JSON.stringify({
          ...BASE,
          type: "item",
          phase: "completed",
          payload: { type: "agentMessage", id: "live", text: "live answer" },
        }),
      );
    });
    await flushStream(() => {
      expect(result.current.getStream("task-1").entries).toHaveLength(1);
    });

    await act(async () => {
      resolveHistory({ frames: [frame({ type: "agentMessage", id: "a1", text: "replayed" })] });
      await pending;
    });

    const state = result.current.getStream("task-1");
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].item).toMatchObject({ id: "live" });
    expect(state.history.state).toBe("idle");
  });

  it("surfaces a failed replay without retrying in a loop", async () => {
    invokeMock.mockRejectedValue("Session file not found");

    const { result } = renderHook(() => useCodexStream());
    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/missing.jsonl", "/proj");
      await result.current.hydrateHistory("task-1", "/sessions/missing.jsonl", "/proj");
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.getStream("task-1").history).toEqual({
      state: "failed",
      reason: "Session file not found",
    });
  });

  it("resetTask clears the replay record so a rerun can replay again", async () => {
    invokeMock.mockResolvedValue({ frames: [frame({ type: "agentMessage", id: "a1", text: "x" })] });
    const { result } = renderHook(() => useCodexStream());

    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/rollout-e.jsonl", "/proj");
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.resetTask("task-1");
    });

    await act(async () => {
      await result.current.hydrateHistory("task-1", "/sessions/rollout-e.jsonl", "/proj");
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
