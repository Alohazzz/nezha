import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexUserInputRequest } from "../types";
import { useCodexStream } from "../hooks/useCodexStream";

// 提问事件同样走全局 emit（`codex-user-input-requested`），jsdom 无 Tauri runtime，
// 按仓库惯例 mock listen 并把回调抓出来手动触发。
type EventHandler = (e: { payload: unknown }) => void;
const handlers = new Map<string, EventHandler[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: EventHandler) => {
    const list = handlers.get(name) ?? [];
    list.push(cb);
    handlers.set(name, list);
    return Promise.resolve(() => undefined);
  }),
}));

function emit(name: string, payload: unknown) {
  for (const cb of handlers.get(name) ?? []) cb({ payload });
}

const QUESTION_EVENT: CodexUserInputRequest = {
  task_id: "task-1",
  request_id: 7,
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "call_abc",
  isBlocking: true,
  questions: [
    {
      id: "scope",
      header: "范围",
      question: "改哪些入口?",
      isOther: true,
      options: [{ label: "仅PC", description: "风险最小" }],
    },
  ],
};

function frameLine(item: Record<string, unknown>): string {
  return JSON.stringify({
    taskId: "task-1",
    threadId: "thread-1",
    turnId: "turn-1",
    type: "item",
    phase: "started",
    payload: item,
  });
}

describe("useCodexStream 模型提问", () => {
  beforeEach(() => {
    handlers.clear();
  });

  it("收到提问事件后入快照，应答后清空", async () => {
    const { result } = renderHook(() => useCodexStream());

    act(() => emit("codex-user-input-requested", QUESTION_EVENT));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).not.toBeNull());
    expect(result.current.getStream("task-1").userInput?.questions[0].id).toBe("scope");

    act(() => result.current.setUserInputResolved("task-1"));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).toBeNull());
  });

  it("提问先于任何数据帧到达时也能寻址", async () => {
    // 模型一上来就提问（还没发任何 item 帧）：必须建空模型占位，
    // 否则 getStream 返回的是与快照脱节的空态，卡片永远不显示。
    const { result } = renderHook(() => useCodexStream());
    act(() => emit("codex-user-input-requested", QUESTION_EVENT));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).not.toBeNull());
    expect(result.current.getStream("task-1").entries).toEqual([]);
  });

  it("后续条目增量不会把提问冲掉", async () => {
    // 高频帧走 flush 路径重建 state，提问槽位必须从上一个快照继承，
    // 否则提问会在下一个 delta 到达时凭空消失、turn 却还挂着。
    const { result } = renderHook(() => useCodexStream());
    act(() => emit("codex-user-input-requested", QUESTION_EVENT));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).not.toBeNull());

    act(() =>
      result.current.ingestFrameLine(
        "task-1",
        frameLine({ type: "agentMessage", id: "m1", text: "hello" }),
      ),
    );
    await waitFor(() => expect(result.current.getStream("task-1").entries.length).toBe(1));
    expect(result.current.getStream("task-1").userInput?.request_id).toBe(7);
  });

  it("beginFollowUpRound 同时清掉审批与提问残留", async () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => emit("codex-user-input-requested", QUESTION_EVENT));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).not.toBeNull());

    act(() => result.current.beginFollowUpRound("task-1"));
    await waitFor(() => expect(result.current.getStream("task-1").userInput).toBeNull());
  });
});
