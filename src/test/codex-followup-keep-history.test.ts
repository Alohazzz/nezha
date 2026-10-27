import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCodexStream } from "../hooks/useCodexStream";
import { createStreamModel, ingestFrameLine } from "../hooks/codexStreamMerge";

// hook 挂载时订阅 codex-approval-requested：jsdom 无 Tauri runtime，按仓库
// 惯例 mock listen（git-roots-refresh.test.tsx 同款）。
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

// 快照经 RAF/兜底 timer（100ms）异步 flush，断言前轮询等快照落地。
// cond 返回 true 即视为 flush 完成（waitFor 内部持续重试）。
async function flushStream(cond: () => void, timeout = 2000): Promise<void> {
  await waitFor(cond, { timeout, interval: 50 });
}

// 回归：structured 任务「Agent 停下询问 → 用户回答」走 resume 通道。旧实现在
// resume 前 resetTask 清光历史（thread/resume 不回放历史 item，forwarder 又在
// resume 之后才订阅上游事件），导致回答后整个会话流被清空只剩新一轮内容。
// 修复后 resume 开轮只清 usage/审批残留，entries 保留（beginFollowUpRound）。

// 帧形状对齐后端 task_bridge::emit_stream_event（camelCase、phase、itemId）。
const BASE = { taskId: "task-1", threadId: "thread-1", turnId: "turn-1" };

function line(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE, type, ...extra });
}

function itemLine(phase: "started" | "completed", item: Record<string, unknown>): string {
  return line("item", { phase, payload: item });
}

const USAGE = {
  total: {
    totalTokens: 100,
    inputTokens: 80,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 5,
  },
  last: {
    totalTokens: 40,
    inputTokens: 30,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningOutputTokens: 2,
  },
  modelContextWindow: 200000,
};

describe("useCodexStream resume 开轮保留历史（回答后页面被清空的回归）", () => {
  it("beginFollowUpRound keeps prior entries and clears only usage/approval", async () => {
    const { result } = renderHook(() => useCodexStream());

    // 第一轮：完整跑完一个 turn（用户消息 → agent 回复 → usage → done）
    act(() => {
      result.current.ingestFrameLine(
        "task-1",
        itemLine("completed", { type: "userMessage", id: "um-1", content: [{ type: "text", text: "修这个 bug" }] }),
      );
      result.current.ingestFrameLine(
        "task-1",
        itemLine("completed", { type: "agentMessage", id: "msg-1", text: "先确认复现步骤？" }),
      );
      result.current.ingestFrameLine(
        "task-1",
        line("tokenUsage", { phase: "updated", payload: USAGE }),
      );
    });
    await flushStream(() =>
      expect(result.current.getStream("task-1").entries).toHaveLength(2),
    );
    expect(result.current.getStream("task-1").entries).toHaveLength(2);
    expect(result.current.getStream("task-1").usage).not.toBeNull();

    // 任务 done。Agent 停下询问 → 用户在 composer 输入回答 → resume 开轮
    act(() => {
      result.current.beginFollowUpRound("task-1");
      result.current.appendLocalUserMessage("task-1", "步骤是 xyz");
    });
    await flushStream(() =>
      expect(result.current.getStream("task-1").entries).toHaveLength(3),
    );

    const after = result.current.getStream("task-1");
    // 历史两条 + 乐观回答气泡 = 3，绝不能被清空
    expect(after.entries).toHaveLength(3);
    expect(after.entries[0].kind).toBe("userMessage");
    expect(after.entries[1].kind).toBe("agentMessage");
    expect(after.entries[2].kind).toBe("userMessage");
    // usage/审批残留被清掉，等新一轮 tokenUsage 帧重置
    expect(after.usage).toBeNull();
    expect(after.approval).toBeNull();
  });

  it("beginFollowUpRound is safe when there is no prior usage/approval to clear", async () => {
    // input_required（审批挂起）场景下回答后开轮：审批卡片经 setApprovalResolved
    // 清除后，beginFollowUpRound 不得因快照缺失/审批已空而清掉条目。
    const { result } = renderHook(() => useCodexStream());
    act(() => {
      result.current.ingestFrameLine(
        "task-1",
        itemLine("completed", { type: "agentMessage", id: "msg-1", text: "hello" }),
      );
    });
    act(() => {
      result.current.setApprovalResolved("task-1");
      result.current.beginFollowUpRound("task-1");
    });
    await flushStream(() =>
      expect(result.current.getStream("task-1").entries).toHaveLength(1),
    );
    expect(result.current.getStream("task-1").entries).toHaveLength(1);
    expect(result.current.getStream("task-1").approval).toBeNull();
  });

  it("second round frames merge after the kept history without id collisions", async () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => {
      result.current.ingestFrameLine(
        "task-1",
        itemLine("completed", { type: "agentMessage", id: "msg-1", text: "round 1" }),
      );
      result.current.beginFollowUpRound("task-1");
      result.current.appendLocalUserMessage("task-1", "继续");
      // 新一轮条目（上游新生成 id）+ delta 流式增长
      result.current.ingestFrameLine(
        "task-1",
        itemLine("started", { type: "agentMessage", id: "msg-2", text: "" }),
      );
      result.current.ingestFrameLine("task-1", line("agentMessageDelta", { phase: "delta", itemId: "msg-2", payload: { delta: "round " } }));
      result.current.ingestFrameLine("task-1", line("agentMessageDelta", { phase: "delta", itemId: "msg-2", payload: { delta: "2" } }));
    });
    await flushStream(() =>
      expect(result.current.getStream("task-1").entries).toHaveLength(3),
    );

    const entries = result.current.getStream("task-1").entries;
    expect(entries).toHaveLength(3);
    expect(entries[2].kind).toBe("agentMessage");
    // delta 归并到新一轮条目，不污染历史
    expect((entries[2].item as { text: string }).text).toBe("round 2");
    expect((entries[0].item as { text: string }).text).toBe("round 1");
  });

  it("beginFollowUpRound is a no-op snapshot-wise for unknown tasks (resetTask still wipes)", async () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => {
      result.current.beginFollowUpRound("task-x");
    });
    expect(result.current.getStream("task-x").entries).toEqual([]);

    // 对照：重跑语义（invokeRunTask 前清流）依旧是 resetTask，整体抹掉
    const model = createStreamModel();
    ingestFrameLine(model, itemLine("completed", { type: "agentMessage", id: "m", text: "x" }));
    expect(model.entries).toHaveLength(1);
    act(() => {
      result.current.resetTask("task-x");
    });
    expect(result.current.getStream("task-x").entries).toEqual([]);
  });
});
