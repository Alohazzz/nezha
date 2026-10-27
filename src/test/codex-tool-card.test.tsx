import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { codexToolCardExpansion, CodexToolCard } from "../components/codex-stream/CodexToolCard";
import { CodexReasoningEntry } from "../components/codex-stream/CodexReasoningEntry";

// jsdom 缺少 Radix Popover 交互所需的 pointer capture API。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function renderCard(props: Partial<Parameters<typeof CodexToolCard>[0]> = {}) {
  return render(
    <I18nProvider>
      <CodexToolCard
        entryId="cmd-1"
        icon={<span data-testid="icon" />}
        category="Command"
        text="npm install"
        status="ok"
        collapsible
        autoExpandWhileRunning
        autoCollapseOnDone
        {...props}
      >
        <div data-testid="children-content">output body</div>
      </CodexToolCard>
    </I18nProvider>,
  );
}

function childrenVisible() {
  return screen.queryByTestId("children-content") !== null;
}

afterEach(() => {
  codexToolCardExpansion.clear();
  window.localStorage.clear();
});

describe("CodexToolCard", () => {
  it("keeps manual expansion across unmount/remount (module-level persistence)", () => {
    const first = renderCard({ status: "ok" });
    // 默认收起
    expect(childrenVisible()).toBe(false);

    // 手动展开后卸载重挂载：展开态保持（模拟切任务回来）
    fireEvent.click(screen.getByRole("button", { name: /npm install/ }));
    expect(childrenVisible()).toBe(true);
    first.unmount();

    renderCard({ status: "ok" });
    expect(childrenVisible()).toBe(true);
  });

  it("auto-expands once on running+revision edge and auto-collapses once on completion edge", () => {
    const view = renderCard({ status: "running", streamingRevision: 0 });
    // 运行中 + revision 上升 → 自动展开
    expect(childrenVisible()).toBe(true);

    view.rerender(
      <I18nProvider>
        <CodexToolCard
          entryId="cmd-1"
          icon={<span data-testid="icon" />}
          category="Command"
          text="npm install"
          status="running"
          streamingRevision={5}
          collapsible
          autoExpandWhileRunning
          autoCollapseOnDone
        >
          <div data-testid="children-content">output body</div>
        </CodexToolCard>
      </I18nProvider>,
    );
    // 仍在流式中，保持展开
    expect(childrenVisible()).toBe(true);

    // 运行 → 完成边沿 → 自动收起
    view.rerender(
      <I18nProvider>
        <CodexToolCard
          entryId="cmd-1"
          icon={<span data-testid="icon" />}
          category="Command"
          text="npm install"
          status="ok"
          collapsible
          autoExpandWhileRunning
          autoCollapseOnDone
        >
          <div data-testid="children-content">output body</div>
        </CodexToolCard>
      </I18nProvider>,
    );
    expect(childrenVisible()).toBe(false);
  });

  it("manual collapse wins permanently over subsequent auto-expand", () => {
    const view = renderCard({ status: "running", streamingRevision: 0 });
    expect(childrenVisible()).toBe(true);

    // 流式中手动收起
    fireEvent.click(screen.getByRole("button", { name: /npm install/ }));
    expect(childrenVisible()).toBe(false);

    // 后续 revision 继续涨：不再被自动展开抢回去
    view.rerender(
      <I18nProvider>
        <CodexToolCard
          entryId="cmd-1"
          icon={<span data-testid="icon" />}
          category="Command"
          text="npm install"
          status="running"
          streamingRevision={9}
          collapsible
          autoExpandWhileRunning
          autoCollapseOnDone
        >
          <div data-testid="children-content">output body</div>
        </CodexToolCard>
      </I18nProvider>,
    );
    expect(childrenVisible()).toBe(false);
  });

  it("renders failed status tooltip trigger with copyable error detail", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    renderCard({
      status: "failed",
      statusLabel: "exit 1",
      failureDetail: "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1",
    });

    // 状态词是独立的 tooltip 触发（title 语义），与外层摘要行按钮区分
    const trigger = screen.getByTitle("View failure detail");
    expect(trigger).toBeTruthy();
    // 点击状态词打开失败详情
    fireEvent.click(trigger);
    const detail = await screen.findByText(/npm ERR! errno 1/);
    expect(detail).toBeTruthy();

    // tooltip 内复制按钮可点
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "npm ERR! code ELIFECYCLE\nnpm ERR! errno 1",
    );
  });

  it("does not nest a button in the summary row and never toggles the card from the failure trigger", async () => {
    // 回归（review P1）：tooltip 触发器之前是 <button> 嵌在摘要行 <button> 里——
    // 非法嵌套 HTML，且点击会冒泡切换卡片体。
    renderCard({
      status: "failed",
      statusLabel: "exit 1",
      failureDetail: "boom",
    });

    // 触发器不再是 button 元素（禁止嵌套 <button>）
    const trigger = screen.getByTitle("View failure detail");
    expect(trigger.tagName).not.toBe("BUTTON");

    // 点击触发器：tooltip 打开，同时卡片体不得切换
    fireEvent.click(trigger);
    await screen.findByText("boom");
    expect(childrenVisible()).toBe(false);
  });

  it("renders the summary row even when collapsible is false (output-less command)", () => {
    // 回归（review P1）：非折叠形态之前只渲染 children——无输出的命令卡只剩
    // 空边框盒。现在摘要行照常展示（不可交互的 div 头部）。
    renderCard({ collapsible: false, status: "ok", statusLabel: "exit 0" });
    // 命令文本与状态可见
    expect(screen.getByText("npm install")).toBeTruthy();
    expect(screen.getByText("exit 0")).toBeTruthy();
    // 头部不可交互：无 toggle 按钮，children 直接渲染
    expect(screen.queryByRole("button", { name: /npm install/ })).toBeNull();
    expect(childrenVisible()).toBe(true);
  });

  it("renders children directly when collapsible is false (non-folding usage)", () => {
    renderCard({ collapsible: false, status: "ok" });
    expect(childrenVisible()).toBe(true);
    // 不折叠形态下没有切换按钮
    expect(screen.queryByRole("button", { name: /npm install/ })).toBeNull();
  });

  it("keeps collapsed by default even when ok arrives directly (no running phase)", () => {
    renderCard({ status: "ok", streamingRevision: undefined });
    expect(childrenVisible()).toBe(false);
  });

  it("runs markers stay in sync via onToggleExpand callback", () => {
    const onToggle = vi.fn();
    renderCard({ status: "ok", onToggleExpand: onToggle });
    fireEvent.click(screen.getByRole("button", { name: /npm install/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /npm install/ }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("does not setState per revision while idle user-collapsed state persists", () => {
    // 手动展开后 revision 涨不改变展开态（自动让位给手动）
    const view = renderCard({ status: "ok" });
    fireEvent.click(screen.getByRole("button", { name: /npm install/ }));
    act(() => {
      view.rerender(
        <I18nProvider>
          <CodexToolCard
            entryId="cmd-1"
            icon={<span data-testid="icon" />}
            category="Command"
            text="npm install"
            status="ok"
            streamingRevision={3}
            collapsible
            autoExpandWhileRunning
            autoCollapseOnDone
          >
            <div data-testid="children-content">output body</div>
          </CodexToolCard>
        </I18nProvider>,
      );
    });
    expect(childrenVisible()).toBe(true);
  });
});

// ── 思考卡行为矩阵（issue #119）──────────────────────────────────────────────
// 通过 CodexReasoningEntry 驱动：时间字段（startedAtMs/endedAtMs）决定 running/ok
// 状态，骨架的自动边沿据此展开/收起；摘要行呈现动态/定格计时。

describe("CodexReasoningEntry (issue #119)", () => {
  function renderReasoning(props: {
    startedAtMs?: number | null;
    endedAtMs?: number | null;
    revision?: number;
    summary?: string[];
  }) {
    return render(
      <I18nProvider>
        <CodexReasoningEntry
          item={{
            type: "reasoning",
            id: "think-1",
            summary: props.summary ?? ["A stream of thought."],
          }}
          revision={props.revision}
          startedAtMs={props.startedAtMs}
          endedAtMs={props.endedAtMs}
        />
      </I18nProvider>,
    );
  }

  function thoughtBodyVisible() {
    // 展开区（完整 summary.join）与摘要行文本同源——用 body testid 精确定位
    return screen.queryByTestId("codex-reasoning-body") !== null;
  }

  afterEach(() => {
    codexToolCardExpansion.clear();
    window.localStorage.clear();
  });

  it("auto-expands while running and shows the live ticking duration", () => {
    renderReasoning({ startedAtMs: Date.now() - 2000, endedAtMs: null, revision: 1 });
    // 运行中自动展开：思考文本直接可见
    expect(thoughtBodyVisible()).toBe(true);
    // 状态词 running（en 表下 status 与 chip 同文案，用 class 精确定位）与动态秒数
    expect(document.querySelector('.codex-stream-tool-status[data-status="running"]')).not.toBeNull();
    expect(screen.getByText(/^[0-9]+(\.[0-9]+)?s$/)).toBeTruthy();
  });

  it("auto-collapses on completion and freezes the total duration", () => {
    const view = renderReasoning({ startedAtMs: 1000, endedAtMs: null, revision: 1 });
    expect(thoughtBodyVisible()).toBe(true);

    // 完成边沿：endedAtMs 写入 → status ok → 自动收起 + 定格时长
    view.rerender(
      <I18nProvider>
        <CodexReasoningEntry
          item={{ type: "reasoning", id: "think-1", summary: ["A stream of thought."] }}
          revision={1}
          startedAtMs={1000}
          endedAtMs={4200}
        />
      </I18nProvider>,
    );
    expect(thoughtBodyVisible()).toBe(false);
    expect(screen.getByText("Thought")).toBeTruthy();
    // 定格时长 = 4200-1000 = 3.2s（权威帧时间差，不是本地时钟）
    expect(screen.getByText("3.2s")).toBeTruthy();
  });

  it("manual toggle wins permanently over the auto rhythm", () => {
    const view = renderReasoning({ startedAtMs: Date.now() - 1000, endedAtMs: null, revision: 1 });
    expect(thoughtBodyVisible()).toBe(true);

    // 流式中手动收起
    fireEvent.click(screen.getByRole("button", { name: /A stream of thought/ }));
    expect(thoughtBodyVisible()).toBe(false);

    // revision 继续涨不被抢回
    view.rerender(
      <I18nProvider>
        <CodexReasoningEntry
          item={{ type: "reasoning", id: "think-1", summary: ["A stream of thought."] }}
          revision={5}
          startedAtMs={Date.now() - 1000}
          endedAtMs={null}
        />
      </I18nProvider>,
    );
    expect(thoughtBodyVisible()).toBe(false);
  });

  it("renders the first summary line as the summary text and keeps a completed card collapsed by default", () => {
    renderReasoning({ startedAtMs: 1000, endedAtMs: 4200 });
    // 摘要首行截断可见
    expect(screen.getByText(/A stream of thought/)).toBeTruthy();
    // 完成态默认收起（现有行为矩阵语义）
    expect(thoughtBodyVisible()).toBe(false);
  });

  it("truncates long summary lines to ~80 characters in the summary row", () => {
    const longLine = "x".repeat(200);
    renderReasoning({ startedAtMs: 1000, endedAtMs: 4200, summary: [longLine] });
    const shown = screen.getByText(/^x+$/).textContent ?? "";
    expect(shown.length).toBe(80);
  });
});
