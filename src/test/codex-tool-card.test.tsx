import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { codexToolCardExpansion, CodexToolCard } from "../components/codex-stream/CodexToolCard";

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

    // 状态词是独立的 tooltip 触发按钮（title 语义），与外层摘要行按钮区分
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
