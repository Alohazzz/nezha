import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexUserMessageItem,
} from "../types";

// ── 轮次段渲染（对标 ZCode ConversationWorkSegmentFlow）──────────────────────
// 接缝：CodexStreamView 拿一轮完整条目流，渲染出
//   用户气泡 → 「已工作 X 秒」折叠头 → 过程区（收起）→ 结论（常驻）。
// 此前是平铺：过程与结论同权重，结束那一刻看到的是最后一屏工具日志。

function user(id: string, text = id): CodexStreamEntry {
  return {
    kind: "userMessage",
    revision: 0,
    startedAtMs: null,
    endedAtMs: null,
    item: {
      type: "userMessage",
      id,
      content: [{ type: "text", text }],
    } satisfies CodexUserMessageItem,
  };
}

function cmd(id: string, start = 1_000, end = 2_000): CodexStreamEntry {
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
      aggregatedOutput: `out-${id}`,
      exitCode: 0,
      durationMs: end - start,
    } satisfies CodexCommandExecutionItem,
  };
}

function agent(id: string, text: string, start = 2_000, end = 62_000): CodexStreamEntry {
  return {
    kind: "agentMessage",
    revision: 0,
    startedAtMs: start,
    endedAtMs: end,
    item: { type: "agentMessage", id, text } satisfies CodexAgentMessageItem,
  };
}

function renderStream(entries: CodexStreamEntry[], running = false, statusText?: string) {
  return render(
    <I18nProvider>
      <CodexStreamView
        entries={entries}
        usage={null}
        approval={null}
        onApprovalResolved={() => {}}
        running={running}
        statusText={statusText}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  codexToolCardExpansion.clear();
  window.localStorage.clear();
});

describe("turn section rendering", () => {
  it("collapses the process and keeps the final answer visible", () => {
    renderStream([user("u1"), cmd("c1"), agent("a1", "the answer")]);

    // 折叠头给出耗时（61s 跨度）
    expect(screen.getByRole("button", { name: /Worked for/ })).toBeTruthy();
    // 过程收起：命令不可见
    expect(screen.queryByText("echo c1")).toBeNull();
    // 结论常驻
    expect(screen.getByText("the answer")).toBeTruthy();
  });

  it("expands the process on demand", () => {
    renderStream([user("u1"), cmd("c1"), agent("a1", "the answer")]);
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }));
    expect(screen.getByTestId("codex-turn-process")).toBeTruthy();
    expect(screen.getByText("echo c1")).toBeTruthy();
  });

  it("keeps the process open while the turn is running", () => {
    renderStream([user("u1"), cmd("c1", 1_000, 2_000)], true);
    // 运行中要能看见实况
    expect(screen.getByTestId("codex-turn-process")).toBeTruthy();
    expect(screen.getByText("echo c1")).toBeTruthy();
    // 「正在工作」在折叠头，整轮活性指示在流尾
    expect(screen.getAllByText(/Working/).length).toBeGreaterThan(0);
  });

  it("pins an inline loading spinner at the end of the running process area", () => {
    // 长命令静默期（如 pnpm install 跑 2 分钟）：最后一行内容不动，段内末尾的
    // 旋转 spinner 是「还在跑」的就近信号。
    const running = renderStream([user("u1"), cmd("c1", 1_000, 2_000)], true);
    const process = screen.getByTestId("codex-turn-process");
    expect(process.querySelector(".codex-stream-working")).not.toBeNull();
    expect(process.querySelector(".codex-stream-working-spinner")).not.toBeNull();
    running.unmount();

    // 同一条目流按已完成收口后，inline 指示器消失，不留定格残影
    renderStream([user("u1"), cmd("c1", 1_000, 2_000)], false);
    expect(
      screen
        .getByTestId("codex-turn-process")
        .querySelector(".codex-stream-working"),
    ).toBeNull();
  });

  it("shows a stopped label for interrupted turns", () => {
    renderStream([user("u1"), cmd("c1")], false, "Turn stopped");
    expect(screen.getByRole("button", { name: /Stopped/ })).toBeTruthy();
  });

  it("does not render a collapse header when there is no process", () => {
    // 提问后直接给答复：一行「已工作 2 秒」点开是空的，纯噪音
    renderStream([user("u1"), agent("a1", "instant answer", 1_000, 1_200)]);
    expect(screen.queryByRole("button", { name: /Worked/ })).toBeNull();
    expect(screen.getByText("instant answer")).toBeTruthy();
  });

  it("states explicitly that a finished turn left no answer", () => {
    renderStream([user("u1"), cmd("c1")]);
    expect(screen.getByTestId("codex-turn-empty-answer")).toBeTruthy();
  });

  it("splits independent user inputs into separate turns", () => {
    renderStream([
      user("u1", "first ask"),
      cmd("c1"),
      agent("a1", "first answer", 2_000, 3_000),
      user("u2", "second ask"),
      cmd("c2", 3_000, 4_000),
      agent("a2", "second answer", 4_000, 5_000),
    ]);
    expect(screen.getByText("first ask")).toBeTruthy();
    expect(screen.getByText("second ask")).toBeTruthy();
    expect(screen.getByText("first answer")).toBeTruthy();
    expect(screen.getByText("second answer")).toBeTruthy();
    // 两段各一个折叠头
    expect(screen.getAllByRole("button", { name: /Worked for/ })).toHaveLength(2);
  });

  it("renders assistant-only history flat instead of hiding it under a collapse", () => {
    // 冷恢复续跑：首条用户消息之前的内容不是用户发起的，不能折叠
    renderStream([cmd("c0"), agent("a0", "resumed output", 2_000, 3_000)]);
    expect(screen.getByText("echo c0")).toBeTruthy();
    expect(screen.getByText("resumed output")).toBeTruthy();
  });
});

describe("stream footer", () => {
  it("closes the stream with state, duration and work summary", () => {
    const { container } = renderStream([
      user("u1"),
      cmd("c1", 1_000, 2_000),
      cmd("c2", 2_000, 61_000),
      agent("a1", "done", 61_000, 62_000),
    ]);
    const footer = container.querySelector(".codex-stream-footer");
    expect(footer).not.toBeNull();
    expect(footer?.getAttribute("data-state")).toBe("done");
    expect(screen.getByText("2 command(s)")).toBeTruthy();
  });

  it("does not invent a failure reason for an interrupted turn", () => {
    // statusTone 缺省是 warning（中断 / 断开）：页脚按「已停止」收口，
    // 不能把中断横幅的文案当成失败原因再复述一遍。
    const { container } = renderStream([user("u1"), cmd("c1")], false, "Turn stopped");
    const footer = container.querySelector(".codex-stream-footer");
    expect(footer?.getAttribute("data-state")).toBe("interrupted");
    expect(screen.queryByTestId("codex-stream-footer-reason")).toBeNull();
  });

  it("routes the failure reason through the panel prop", () => {
    const { container } = render(
      <I18nProvider>
        <CodexStreamView
          entries={[user("u1"), cmd("c1")]}
          usage={null}
          approval={null}
          onApprovalResolved={() => {}}
          running={false}
          statusText="quota exhausted"
          statusTone="error"
        />
      </I18nProvider>,
    );
    expect(container.querySelector(".codex-stream-footer")?.getAttribute("data-state")).toBe("failed");
    expect(screen.getByText("Task failed")).toBeTruthy();
  });

  it("does not flag a plan-only turn as missing an answer", () => {
    // 计划本身就是交付物：没有最终叙述也不算「没有答复」
    const plan: CodexStreamEntry = {
      kind: "plan",
      revision: 0,
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      item: { type: "plan", id: "p1", text: "1. do the thing" },
    };
    renderStream([user("u1"), plan]);
    expect(screen.queryByTestId("codex-turn-empty-answer")).toBeNull();
  });

  it("does not render a footer while the turn is still running", () => {
    const { container } = renderStream([user("u1"), cmd("c1")], true);
    expect(container.querySelector(".codex-stream-footer")).toBeNull();
  });

  it("does not render a footer for an empty stream", () => {
    const { container } = renderStream([]);
    expect(container.querySelector(".codex-stream-footer")).toBeNull();
  });
});
