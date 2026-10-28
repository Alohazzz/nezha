import { describe, expect, it } from "vitest";
import { segmentTurnEntries } from "../components/codex-stream/codexTurnSegments";
import { summarizeCodexStream } from "../components/codex-stream/codexStreamSummary";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexReasoningItem,
  CodexUserMessageItem,
} from "../types";

// ── 轮次分段（对标 ZCode ConversationTurnWorkSegment）─────────────────────────
// 接缝：条目流 → { segments, orphanItems }。每条用户消息开一轮；过程与结论
// 分离；只有最后一段继承 running / interrupted。纯函数，直接喂条目驱动。

function user(id: string, startedAtMs?: number): CodexStreamEntry {
  return {
    kind: "userMessage",
    revision: 0,
    startedAtMs: startedAtMs ?? null,
    endedAtMs: null,
    item: {
      type: "userMessage",
      id,
      content: [{ type: "text", text: id }],
    } satisfies CodexUserMessageItem,
  };
}

function agent(id: string, text: string, start: number, end: number): CodexStreamEntry {
  return {
    kind: "agentMessage",
    revision: 0,
    startedAtMs: start,
    endedAtMs: end,
    item: { type: "agentMessage", id, text } satisfies CodexAgentMessageItem,
  };
}

function cmd(id: string, start: number, end: number): CodexStreamEntry {
  return {
    kind: "commandExecution",
    revision: 0,
    startedAtMs: start,
    endedAtMs: end,
    item: {
      type: "commandExecution",
      id,
      command: `echo ${id}`,
      cwd: "/repo",
      status: "completed",
      aggregatedOutput: "",
      exitCode: 0,
      durationMs: end - start,
    } satisfies CodexCommandExecutionItem,
  };
}

function reasoning(id: string, start: number, end: number): CodexStreamEntry {
  return {
    kind: "reasoning",
    revision: 0,
    startedAtMs: start,
    endedAtMs: end,
    item: { type: "reasoning", id, summary: ["thinking"] } satisfies CodexReasoningItem,
  };
}

describe("segmentTurnEntries", () => {
  it("starts a new segment at every user message", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), cmd("c1", 1, 2), user("u2"), cmd("c2", 3, 4)],
      { running: false },
    );
    expect(segments).toHaveLength(2);
    expect(segments[0]?.userMessage.item.id).toBe("u1");
    expect(segments[0]?.processItems).toHaveLength(1);
    expect(segments[1]?.userMessage.item.id).toBe("u2");
    expect(segments[1]?.processItems).toHaveLength(1);
  });

  it("lifts the last assistant message out of the process as the answer", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), cmd("c1", 1, 2), agent("a1", "done", 2, 3)],
      { running: false },
    );
    const [segment] = segments;
    expect(segment?.answer?.item.id).toBe("a1");
    // 结论不进过程区，否则收起时会重复出现两次
    expect(segment?.processItems).toHaveLength(1);
  });

  it("keeps intermediate assistant messages in the process", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), agent("a1", "looking", 1, 2), cmd("c1", 2, 3), agent("a2", "done", 3, 4)],
      { running: false },
    );
    const [segment] = segments;
    // 只有最后一条被提升；中间叙述留在过程里
    expect(segment?.answer?.item.id).toBe("a2");
    expect(segment?.processItems).toHaveLength(2);
  });

  it("does not lift an answer while the turn is still running", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), cmd("c1", 1, 2), agent("a1", "partial", 2, 3)],
      { running: true },
    );
    const [segment] = segments;
    // 正文还在增长：提前提到折叠区外会让完成瞬间整段重排
    expect(segment?.answer).toBeNull();
    expect(segment?.processItems).toHaveLength(2);
    expect(segment?.state).toBe("running");
  });

  it("keeps a final answer when the turn ends with reasoning instead of text", () => {
    // 模型偶尔以 reasoning / plan 收尾：只认「末条目」会让整轮折叠后一个字都不剩。
    const { segments } = segmentTurnEntries(
      [user("u1"), agent("a1", "done", 1, 2), reasoning("r1", 2, 3)],
      { running: false },
    );
    expect(segments[0]?.answer?.item.id).toBe("a1");
  });

  it("only lets the last segment inherit the terminal state", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), cmd("c1", 1, 2), user("u2"), cmd("c2", 3, 4)],
      { running: true },
    );
    expect(segments[0]?.state).toBe("completed");
    expect(segments[1]?.state).toBe("running");
  });

  it("marks the last segment interrupted and opens it", () => {
    const { segments } = segmentTurnEntries([user("u1"), cmd("c1", 1, 2)], {
      running: false,
      interrupted: true,
    });
    expect(segments[0]?.state).toBe("interrupted");
    // 中断要能看见停在哪
    expect(segments[0]?.defaultOpen).toBe(true);
  });

  it("collapses a finished segment that has an answer", () => {
    const { segments } = segmentTurnEntries(
      [user("u1"), cmd("c1", 1, 2), agent("a1", "done", 2, 3)],
      { running: false },
    );
    expect(segments[0]?.defaultOpen).toBe(false);
  });

  it("opens a finished segment that never produced an answer", () => {
    // 没有结论时过程本身就是结果，收起去只剩一个时长头
    const { segments } = segmentTurnEntries([user("u1"), cmd("c1", 1, 2)], { running: false });
    expect(segments[0]?.defaultOpen).toBe(true);
  });

  it("computes the process duration from entry timestamps", () => {
    const { segments } = segmentTurnEntries(
      [user("u1", 0), cmd("c1", 1_000, 2_000), cmd("c2", 2_000, 61_000), agent("a1", "done", 61_000, 62_000)],
      { running: false },
    );
    expect(segments[0]?.startedAtMs).toBe(1_000);
    expect(segments[0]?.endedAtMs).toBe(62_000);
  });

  it("never reports a negative duration when clocks disagree", () => {
    // 本地时钟占位起点 + 后端信封完成时刻可能有偏差
    const { segments } = segmentTurnEntries([user("u1", 10_000), cmd("c1", 10_000, 5_000)], {
      running: false,
    });
    expect(segments[0]?.endedAtMs).toBeNull();
  });

  it("returns entries before the first user message as orphan items", () => {
    // 会话从助手侧开始 / 冷恢复续跑：这些动作不是用户发起的，不能折叠
    const { segments, orphanItems } = segmentTurnEntries(
      [cmd("c0", 1, 2), agent("a0", "resumed", 2, 3), user("u1"), cmd("c1", 4, 5)],
      { running: false },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.userMessage.item.id).toBe("u1");
    // 孤儿条目原样进 orphanItems（含那条助手消息——它不属于任何一轮的结论）
    expect(orphanItems).toHaveLength(2);
  });

  it("returns no segments and no orphans for an empty stream", () => {
    expect(segmentTurnEntries([], { running: false })).toEqual({ segments: [], orphanItems: [] });
  });
});

describe("summarizeCodexStream", () => {
  it("sums per-segment work instead of first-to-last span", () => {
    // 两轮之间隔了很久（去开会 / 隔夜续聊）：空闲不算工作
    const entries = [user("u1"), cmd("c1", 0, 10_000), user("u2"), cmd("c2", 3_600_000, 3_610_000)];
    const { segments } = segmentTurnEntries(entries, { running: false });
    const summary = summarizeCodexStream(entries, segments);
    expect(summary.workMs).toBe(20_000);
  });

  it("counts commands, failures and distinct changed files", () => {
    const failed: CodexStreamEntry = {
      kind: "commandExecution",
      revision: 0,
      item: {
        type: "commandExecution",
        id: "cf",
        command: "false",
        cwd: "/repo",
        status: "failed",
        aggregatedOutput: "boom",
        exitCode: 1,
        durationMs: 10,
      } satisfies CodexCommandExecutionItem,
    };
    const change: CodexStreamEntry = {
      kind: "fileChange",
      revision: 0,
      item: {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [
          { path: "a.ts", kind: { type: "update", movePath: null }, diff: "" },
          { path: "b.ts", kind: { type: "add" }, diff: "" },
        ],
      },
    };
    // 同一文件再改一次不应重复计数
    const changeAgain: CodexStreamEntry = {
      kind: "fileChange",
      revision: 0,
      item: {
        type: "fileChange",
        id: "f2",
        status: "completed",
        changes: [{ path: "a.ts", kind: { type: "update", movePath: null }, diff: "" }],
      },
    };
    const entries = [user("u1"), cmd("c1", 0, 10), failed, change, changeAgain];
    const { segments } = segmentTurnEntries(entries, { running: false });
    const summary = summarizeCodexStream(entries, segments);
    expect(summary.commands).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.filesChanged).toBe(2);
  });
});
