import { describe, expect, it } from "vitest";
import {
  MAX_ENTRIES,
  createStreamModel,
  ingestFrameLine,
  type StreamModel,
} from "../hooks/codexStreamMerge";

// 帧形状对齐后端 task_bridge::emit_stream_event（camelCase、phase、itemId）。
const BASE = { taskId: "task-1", threadId: "thread-1", turnId: "turn-1" };

type DeltaType = "agentMessageDelta" | "reasoningDelta" | "commandOutputDelta";

function line(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE, type, ...extra });
}

function itemLine(phase: "started" | "completed", item: Record<string, unknown>): string {
  return line("item", { phase, payload: item });
}

function deltaLine(type: DeltaType, itemId: string, delta: string): string {
  return line(type, { phase: "delta", itemId, payload: { delta } });
}

function feed(model: StreamModel, lines: string[]): void {
  for (const l of lines) ingestFrameLine(model, l);
}

function kinds(model: StreamModel): string[] {
  return model.entries.map((e) => e.kind);
}

function itemOf(entry: unknown): Record<string, unknown> {
  return (entry as { item: Record<string, unknown> }).item;
}

function revOf(entry: unknown): number {
  return (entry as { revision: number }).revision;
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

describe("codexStreamMerge（流式归并纯函数）", () => {
  it("merges a full frame sequence into ordered entries with authoritative completion", () => {
    const model = createStreamModel();
    feed(model, [
      itemLine("completed", { type: "userMessage", id: "um-1", content: [{ type: "text", text: "fix the bug" }] }),
      itemLine("started", { type: "agentMessage", id: "msg-1", text: "" }),
      deltaLine("agentMessageDelta", "msg-1", "Hello "),
      deltaLine("agentMessageDelta", "msg-1", "world"),
      // completed 是权威快照：payload 文本故意与流式累积不同，验证整体替换
      itemLine("completed", { type: "agentMessage", id: "msg-1", text: "Hello world from agent", phase: null }),
      itemLine("started", { type: "reasoning", id: "rea-1", summary: [] }),
      deltaLine("reasoningDelta", "rea-1", "thinking "),
      deltaLine("reasoningDelta", "rea-1", "hard"),
      itemLine("completed", { type: "reasoning", id: "rea-1", summary: ["seg-1", "seg-2"] }),
      itemLine("started", {
        type: "commandExecution",
        id: "cmd-1",
        command: "pnpm test",
        cwd: "/repo",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }),
      deltaLine("commandOutputDelta", "cmd-1", "line-1\n"),
      deltaLine("commandOutputDelta", "cmd-1", "line-2\n"),
      itemLine("completed", {
        type: "commandExecution",
        id: "cmd-1",
        command: "pnpm test",
        cwd: "/repo",
        status: "completed",
        aggregatedOutput: "line-1\nline-2\nall output",
        exitCode: 0,
        durationMs: 1200,
      }),
      itemLine("completed", {
        type: "fileChange",
        id: "fc-1",
        changes: [{ path: "src/a.ts", kind: { type: "update", movePath: null }, diff: "--- a\n+++ b\n" }],
        status: "completed",
      }),
      itemLine("started", { type: "mcpToolCall", id: "mcp-1", server: "srv", tool: "query", status: "inProgress" }),
      itemLine("completed", { type: "mcpToolCall", id: "mcp-1", server: "srv", tool: "query", status: "completed", durationMs: 300 }),
      itemLine("completed", { type: "plan", id: "plan-1", text: "1. do it" }),
      // 上游新增条目：保留为 fallback，不炸
      itemLine("completed", { type: "brandNewUpstream", id: "u-1" }),
      line("tokenUsage", { phase: "updated", payload: USAGE }),
    ]);

    expect(kinds(model)).toEqual([
      "userMessage",
      "agentMessage",
      "reasoning",
      "commandExecution",
      "fileChange",
      "mcpToolCall",
      "plan",
      "fallback",
    ]);

    // completed 权威快照替换流式累积文本
    expect(itemOf(model.byId.get("msg-1")).text).toBe("Hello world from agent");
    expect(itemOf(model.byId.get("rea-1")).summary).toEqual(["seg-1", "seg-2"]);
    expect(itemOf(model.byId.get("cmd-1"))).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregatedOutput: "line-1\nline-2\nall output",
    });
    expect(model.usage?.total.totalTokens).toBe(100);
    expect(model.byId.size).toBe(8);
  });

  it("keeps untouched entries reference-stable and replaces delta'd entries with fresh objects", () => {
    const model = createStreamModel();
    feed(model, [
      itemLine("completed", { type: "userMessage", id: "um-1", content: [{ type: "text", text: "q" }] }),
      itemLine("started", { type: "agentMessage", id: "msg-1", text: "" }),
      deltaLine("agentMessageDelta", "msg-1", "part-1"),
    ]);

    const userBefore = model.entries[0];
    const msgBefore = model.entries[1];
    const msgItemBefore = itemOf(msgBefore);
    expect(msgItemBefore.text).toBe("part-1");

    feed(model, [deltaLine("agentMessageDelta", "msg-1", "-part-2")]);

    const userAfter = model.entries[0];
    const msgAfter = model.entries[1];

    // 未被 delta 的条目：引用与槽位都保持不变（memo 依赖引用相等）
    expect(userAfter).toBe(userBefore);

    // 被 delta 的条目：新对象；旧对象保持 delta 前的内容不被篡改
    expect(msgAfter).not.toBe(msgBefore);
    expect(itemOf(msgAfter).text).toBe("part-1-part-2");
    expect(itemOf(msgAfter)).not.toBe(msgItemBefore);
    expect(msgItemBefore.text).toBe("part-1");
    expect(model.byId.get("msg-1")).toBe(msgAfter);
    expect(model.entries[1]).toBe(msgAfter);

    // reasoning：旧 summary 数组不被篡改
    feed(model, [itemLine("started", { type: "reasoning", id: "rea-1", summary: [] })]);
    const reaBefore = model.entries[2];
    feed(model, [deltaLine("reasoningDelta", "rea-1", "think")]);
    const reaAfter = model.entries[2];
    expect(reaAfter).not.toBe(reaBefore);
    expect(itemOf(reaBefore).summary).toEqual([]);
    expect(itemOf(reaAfter).summary).toEqual(["think"]);

    // commandOutput：旧 aggregatedOutput 不被篡改
    feed(model, [
      itemLine("started", {
        type: "commandExecution",
        id: "cmd-1",
        command: "ls",
        cwd: "/",
        status: "inProgress",
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      }),
    ]);
    const cmdBefore = model.entries[3];
    feed(model, [deltaLine("commandOutputDelta", "cmd-1", "out")]);
    const cmdAfter = model.entries[3];
    expect(cmdAfter).not.toBe(cmdBefore);
    expect(itemOf(cmdBefore).aggregatedOutput).toBeNull();
    expect(itemOf(cmdAfter).aggregatedOutput).toBe("out");
  });

  it("starts entries at revision 0 and advances it on every delta", () => {
    const model = createStreamModel();
    feed(model, [itemLine("started", { type: "agentMessage", id: "msg-1", text: "" })]);
    expect(revOf(model.byId.get("msg-1"))).toBe(0);

    feed(model, [deltaLine("agentMessageDelta", "msg-1", "a")]);
    const afterOne = model.byId.get("msg-1");
    expect(revOf(afterOne)).toBe(1);

    feed(model, [deltaLine("agentMessageDelta", "msg-1", "b")]);
    const afterTwo = model.byId.get("msg-1");
    expect(revOf(afterTwo)).toBe(2);
    expect(afterTwo).not.toBe(afterOne);

    // started 未到时的乱序占位条目同样从 0 起
    feed(model, [deltaLine("reasoningDelta", "rea-x", "t1")]);
    expect(revOf(model.byId.get("rea-x"))).toBe(0);
    feed(model, [deltaLine("reasoningDelta", "rea-x", "t2")]);
    expect(revOf(model.byId.get("rea-x"))).toBe(1);

    // completed 权威快照替换后 revision 归零（新权威阶段开始）
    feed(model, [itemLine("completed", { type: "agentMessage", id: "msg-1", text: "final" })]);
    const completed = model.byId.get("msg-1");
    expect(revOf(completed)).toBe(0);
    expect(completed).not.toBe(afterTwo);
  });

  it("replaces an existing entry in place on authoritative frames while siblings keep identity", () => {
    const model = createStreamModel();
    feed(model, [
      itemLine("started", { type: "agentMessage", id: "msg-1", text: "" }),
      itemLine("started", { type: "reasoning", id: "rea-1", summary: [] }),
    ]);
    expect(kinds(model)).toEqual(["agentMessage", "reasoning"]);
    const reaBefore = model.entries[1];

    feed(model, [itemLine("completed", { type: "agentMessage", id: "msg-1", text: "done" })]);

    // 已有条目原位替换（保持顺序），兄弟条目引用不变
    expect(kinds(model)).toEqual(["agentMessage", "reasoning"]);
    expect(model.entries[1]).toBe(reaBefore);
    expect(itemOf(model.entries[0]).text).toBe("done");
  });

  it("keeps at most MAX_ENTRIES entries and cleans dropped ids from byId", () => {
    const model = createStreamModel();
    const lines: string[] = [];
    const total = MAX_ENTRIES + 10;
    for (let i = 0; i < total; i++) {
      lines.push(itemLine("completed", { type: "userMessage", id: `um-${i}`, content: [] }));
    }
    feed(model, lines);

    expect(model.entries.length).toBe(MAX_ENTRIES);
    // 最老的 10 条被丢弃
    const first = model.entries[0];
    expect(itemOf(first).id).toBe("um-10");
    expect(model.byId.has("um-0")).toBe(false);
    expect(model.byId.has("um-9")).toBe(false);
    expect(model.byId.get("um-10")).toBe(first);
    expect(model.byId.size).toBe(MAX_ENTRIES);
  });

  it("evicts __delta_* placeholder byId keys when id-less entries are dropped", () => {
    // 回归（review P2）：无 id 的流式占位条目按 __delta_<type> 键进 byId；
    // 驱逐时若不清理，占位键会永久残留（泄漏 + 指向已驱逐条目）。
    const model = createStreamModel();
    const lines: string[] = [
      // started 未到：两条占位条目（agentMessage / reasoning 各一）
      deltaLine("agentMessageDelta", "", "stream-a"),
      deltaLine("reasoningDelta", "", "stream-b"),
    ];
    const total = MAX_ENTRIES + 10;
    for (let i = 0; i < total; i++) {
      lines.push(itemLine("completed", { type: "userMessage", id: `um-${i}`, content: [] }));
    }
    feed(model, lines);

    expect(model.entries.length).toBe(MAX_ENTRIES);
    // 占位条目已被挤出窗口
    expect(model.byId.has("__delta_agentMessageDelta")).toBe(false);
    expect(model.byId.has("__delta_reasoningDelta")).toBe(false);
    // 占位键不在 byId 里，条目也不在 entries 里——无残留
    for (const key of model.byId.keys()) {
      expect(key.startsWith("__delta_")).toBe(false);
    }
    expect(model.byId.size).toBe(MAX_ENTRIES);
  });

  it("silently ignores non-JSON lines and malformed frames", () => {
    const model = createStreamModel();
    feed(model, [
      "not json at all",
      "null",
      "[1, 2]",
      JSON.stringify({ noType: true }),
      JSON.stringify({ ...BASE, type: 42 }),
      // 空 delta 丢弃
      line("agentMessageDelta", { phase: "delta", itemId: "ghost", payload: { delta: "" } }),
      // commandOutput 无处可挂则丢弃（不建占位条目）
      line("commandOutputDelta", { phase: "delta", itemId: "ghost-cmd", payload: { delta: "x" } }),
    ]);
    expect(model.entries).toEqual([]);
    expect(model.byId.size).toBe(0);
    expect(model.usage).toBeNull();
  });

  it("parses but ignores turnLifecycle frames (T5 placeholder — no entry, no state change)", () => {
    const model = createStreamModel();
    feed(model, [
      itemLine("started", { type: "agentMessage", id: "msg-1", text: "hello" }),
      // turn 生命周期帧：合法帧型但归并层忽略（spec #117 可选交付占位）
      line("turnLifecycle", { phase: "started", payload: { turn: 2 } }),
      line("turnLifecycle", { phase: "completed", payload: { turn: 2, durationMs: 1200 } }),
      deltaLine("agentMessageDelta", "msg-1", " world"),
    ]);
    // 分隔帧不影响条目流：仍是 1 条消息条目，delta 照常归并
    expect(kinds(model)).toEqual(["agentMessage"]);
    expect(itemOf(model.entries[0]).text).toBe("hello world");
    expect(model.usage).toBeNull();
  });

  it("keeps byId consistent with entries through replacements", () => {
    const model = createStreamModel();
    feed(model, [
      itemLine("started", { type: "agentMessage", id: "msg-1", text: "" }),
      deltaLine("agentMessageDelta", "msg-1", "grow"),
      itemLine("started", { type: "reasoning", id: "rea-1", summary: [] }),
      deltaLine("reasoningDelta", "rea-1", "r"),
    ]);

    const assertConsistent = () => {
      const seen = new Set<string>();
      // 无 id 占位条目 → 插入侧身份键 __delta_<type>（agentMessage/reasoning 两种）
      const placeholders = new Set<string>();
      for (const entry of model.entries) {
        const id = itemOf(entry).id as string | undefined;
        if (id) {
          expect(model.byId.get(id)).toBe(entry);
          seen.add(id);
        } else {
          const kind = (entry as { kind: string }).kind;
          const key = kind === "agentMessage" ? "__delta_agentMessageDelta" : "__delta_reasoningDelta";
          expect(model.byId.get(key)).toBe(entry);
          placeholders.add(key);
        }
      }
      // byId 与 entries 严格一一对应：不得残留已被驱逐/替换掉的键
      expect(model.byId.size).toBe(seen.size + placeholders.size);
      for (const key of model.byId.keys()) {
        expect(seen.has(key) || placeholders.has(key)).toBe(true);
      }
    };
    assertConsistent();

    feed(model, [
      itemLine("completed", { type: "agentMessage", id: "msg-1", text: "final" }),
      // completed 之后再来的 delta 继续归并并再次换新对象
      deltaLine("agentMessageDelta", "msg-1", "??"),
    ]);
    assertConsistent();
    expect(itemOf(model.byId.get("msg-1")).text).toBe("final??");
  });

  it("dedupes the local optimistic user bubble when the authoritative upstream echo lands", () => {
    // resume 通道：App 层先插乐观气泡（__local_ 前缀 id，useCodexStream
    // appendLocalUserMessage 直接 push 进 model，不走 ingestFrameLine），
    // thread/resume 重放上游 UserMessage 帧后应只保留权威条目——不能像
    // 恢复截图那样两条一模一样的「请从上次中断的地方继续完成任务。」并存。
    const model = createStreamModel();
    feed(model, [
      itemLine("started", { type: "reasoning", id: "rs-1", summary: ["thinking"] }),
    ]);
    const localEntry = {
      kind: "userMessage" as const,
      revision: 0,
      item: {
        type: "userMessage" as const,
        id: "__local_1730000000000",
        content: [{ type: "text" as const, text: "请从上次中断的地方继续完成任务。" }],
      },
    };
    model.entries.push(localEntry);
    model.byId.set("__local_1730000000000", localEntry);
    expect(kinds(model)).toEqual(["reasoning", "userMessage"]);
    expect(model.entries.length).toBe(2);

    // 上游权威条目（不同 id、相同内容）落地 → 乐观气泡被剔除
    feed(model, [
      itemLine("completed", {
        type: "userMessage",
        id: "um-1",
        content: [{ type: "text", text: "请从上次中断的地方继续完成任务。" }],
      }),
    ]);
    expect(kinds(model)).toEqual(["reasoning", "userMessage"]);
    expect(model.entries.length).toBe(2);
    expect(itemOf(model.byId.get("um-1")).type).toBe("userMessage");
    expect(model.byId.has("__local_1730000000000")).toBe(false);
  });

  it("keeps the local bubble when the upstream user message has different content", () => {
    // 内容不同（用户改过措辞 / 上一轮残留）不得误删乐观气泡
    const model = createStreamModel();
    const localEntry = {
      kind: "userMessage" as const,
      revision: 0,
      item: {
        type: "userMessage" as const,
        id: "__local_1",
        content: [{ type: "text" as const, text: "hello" }],
      },
    };
    model.entries.push(localEntry);
    model.byId.set("__local_1", localEntry);
    feed(model, [
      itemLine("completed", {
        type: "userMessage",
        id: "um-2",
        content: [{ type: "text", text: "different" }],
      }),
    ]);
    expect(kinds(model)).toEqual(["userMessage", "userMessage"]);
    expect(model.byId.has("__local_1")).toBe(true);
  });

  // ── 时间戳归并（issue #119）─────────────────────────────────────────────────

  function tsOf(entry: unknown): { startedAtMs: unknown; endedAtMs: unknown } {
    const e = entry as { startedAtMs?: unknown; endedAtMs?: unknown };
    return { startedAtMs: e.startedAtMs, endedAtMs: e.endedAtMs };
  }

  function itemLineTs(
    phase: "started" | "completed",
    item: Record<string, unknown>,
    tsMs: number,
  ): string {
    return line("item", { phase, tsMs, payload: item });
  }

  it("adopts envelope timestamps from started/completed frames", () => {
    const model = createStreamModel();
    feed(model, [
      itemLineTs("started", { type: "reasoning", id: "rea-1", summary: [] }, 1000),
      itemLineTs("completed", { type: "reasoning", id: "rea-1", summary: ["s"] }, 4200),
    ]);
    const entry = model.byId.get("rea-1");
    expect(tsOf(entry)).toEqual({ startedAtMs: 1000, endedAtMs: 4200 });

    // 命令条目同样采纳
    feed(model, [
      itemLineTs(
        "started",
        { type: "commandExecution", id: "cmd-1", command: "ls", cwd: "/", status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null },
        5000,
      ),
      itemLineTs(
        "completed",
        { type: "commandExecution", id: "cmd-1", command: "ls", cwd: "/", status: "completed", aggregatedOutput: "", exitCode: 0, durationMs: 700 },
        5700,
      ),
    ]);
    expect(tsOf(model.byId.get("cmd-1"))).toEqual({ startedAtMs: 5000, endedAtMs: 5700 });
  });

  it("falls back to the local clock when frames carry no timestamp", () => {
    // resume 回放 / 旧版本后端：帧无 tsMs → 条目时间字段以本地时钟兜底，
    // completed 后 endedAtMs ≥ startedAtMs（同一 tick 内可能相等）。
    const model = createStreamModel();
    const before = Date.now();
    feed(model, [
      itemLine("started", { type: "reasoning", id: "rea-1", summary: [] }),
      itemLine("completed", { type: "reasoning", id: "rea-1", summary: ["s"] }),
    ]);
    const after = Date.now();
    const { startedAtMs, endedAtMs } = tsOf(model.byId.get("rea-1"));
    expect(startedAtMs).toBeGreaterThanOrEqual(before);
    expect(startedAtMs).toBeLessThanOrEqual(after);
    expect(endedAtMs).toBeGreaterThanOrEqual(startedAtMs as number);
    expect(endedAtMs).toBeLessThanOrEqual(after);
  });

  it("stamps completed-only entries (resume replay without started) with the local clock", () => {
    // resume 回放可能只重放 item/completed：没有 started 帧也没有帧 ts，
    // 起点兜底为本地时钟——卡片仍渲染时长而非无时间态（review fix）。
    const model = createStreamModel();
    const before = Date.now();
    feed(model, [
      itemLine("completed", { type: "reasoning", id: "rea-1", summary: ["s"] }),
      itemLine("completed", { type: "commandExecution", id: "cmd-1", command: "ls", cwd: "/", status: "completed", aggregatedOutput: "", exitCode: 0, durationMs: 700 }),
    ]);
    const after = Date.now();
    for (const id of ["rea-1", "cmd-1"]) {
      const { startedAtMs, endedAtMs } = tsOf(model.byId.get(id));
      expect(startedAtMs).toBeGreaterThanOrEqual(before);
      expect(startedAtMs).toBeLessThanOrEqual(after);
      expect(endedAtMs).toBeGreaterThanOrEqual(startedAtMs as number);
      expect(endedAtMs).toBeLessThanOrEqual(after);
    }
  });

  it("stamps delta placeholder entries with the local clock as their start", () => {
    // 乱序：started 未到，delta 先建占位条目 → startedAtMs = 本地时钟
    const model = createStreamModel();
    const before = Date.now();
    feed(model, [deltaLine("reasoningDelta", "rea-x", "t1")]);
    const after = Date.now();
    const { startedAtMs, endedAtMs } = tsOf(model.byId.get("rea-x"));
    expect(startedAtMs).toBeGreaterThanOrEqual(before);
    expect(startedAtMs).toBeLessThanOrEqual(after);
    expect(endedAtMs).toBeNull();
  });

  it("preserves startedAtMs when the authoritative completed snapshot replaces a streaming placeholder", () => {
    // 关键坑（#119）：classifyItem 建全新 entry，若不沿用 existing 的
    // startedAtMs，completed 权威替换会把流式占位/started 记录的起点冲掉。
    const model = createStreamModel();
    feed(model, [
      itemLineTs("started", { type: "reasoning", id: "rea-1", summary: [] }, 1000),
      deltaLine("reasoningDelta", "rea-1", "thinking"),
      itemLineTs("completed", { type: "reasoning", id: "rea-1", summary: ["seg"] }, 4200),
    ]);
    expect(tsOf(model.byId.get("rea-1"))).toEqual({ startedAtMs: 1000, endedAtMs: 4200 });

    // 占位条目路径：started 未到 → delta 建占位（本地时钟起点）→ completed 沿用
    const model2 = createStreamModel();
    const before = Date.now();
    feed(model2, [deltaLine("reasoningDelta", "rea-2", "t1")]);
    feed(model2, [
      itemLineTs("completed", { type: "reasoning", id: "rea-2", summary: ["seg"] }, Date.now() + 50),
    ]);
    const { startedAtMs, endedAtMs } = tsOf(model2.byId.get("rea-2"));
    expect(startedAtMs).toBeGreaterThanOrEqual(before);
    expect(endedAtMs).toBeGreaterThanOrEqual(startedAtMs as number);
  });

  it("treats malformed tsMs as missing and falls back to the local clock", () => {
    const model = createStreamModel();
    feed(model, [
      line("item", { phase: "started", tsMs: "not-a-number", payload: { type: "reasoning", id: "rea-1", summary: [] } }),
      line("item", { phase: "completed", tsMs: Number.NaN, payload: { type: "reasoning", id: "rea-1", summary: ["s"] } }),
    ]);
    const { startedAtMs, endedAtMs } = tsOf(model.byId.get("rea-1"));
    expect(typeof startedAtMs).toBe("number");
    expect(Number.isFinite(startedAtMs)).toBe(true);
    expect(endedAtMs).toBeGreaterThanOrEqual(startedAtMs as number);
  });

  it("keeps timestamps reference-stable through delta merges", () => {
    // delta 不可变替换必须携带时间字段，memo 卡片据此持续计时
    const model = createStreamModel();
    feed(model, [
      itemLineTs("started", { type: "reasoning", id: "rea-1", summary: [] }, 1000),
      deltaLine("reasoningDelta", "rea-1", "a"),
      deltaLine("reasoningDelta", "rea-1", "b"),
    ]);
    const entry = model.byId.get("rea-1");
    expect(tsOf(entry)).toEqual({ startedAtMs: 1000, endedAtMs: null });
    expect(revOf(entry)).toBe(2);
  });
});
