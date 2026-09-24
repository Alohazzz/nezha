import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { YunxiaoWorkitem } from "../types";
import { I18nProvider } from "../i18n";
import { YunxiaoIssueList } from "../components/yunxiao/YunxiaoIssueList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

function issue(id: number): YunxiaoWorkitem {
  return {
    id: `issue-${id}`,
    serialNumber: `QHDK-${id}`,
    subject: `议题 ${id}`,
    customFieldValues: [],
  };
}

function renderList(overrides: { selectionMode?: boolean } = {}) {
  const onDiscuss = vi.fn();
  const onAddToPlan = vi.fn();
  const onDirectStart = vi.fn();
  render(
    <I18nProvider>
      <YunxiaoIssueList
        issues={[issue(1), issue(2)]}
        total={2}
        loading={false}
        loadingMore={false}
        importedIds={new Set()}
        selectedIds={new Set()}
        selectionMode={overrides.selectionMode ?? false}
        onToggleSelect={vi.fn()}
        onDiscuss={onDiscuss}
        onDirectStart={onDirectStart}
        onAddToPlan={onAddToPlan}
        planNamesByWorkitem={new Map()}
        onLoadMore={vi.fn()}
        yunxiaoProjectId="proj-1"
      />
    </I18nProvider>,
  );
  return { onDiscuss, onAddToPlan, onDirectStart };
}

describe("云效议题列表：行内动作是低调文字按钮（无二级菜单）", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nezha:language", "zh");
  });

  it("三个动作都在行内，没有「…」触发器 / 弹出菜单", async () => {
    renderList();

    expect(await screen.findByTestId("yunxiao-issue-actions-issue-1")).toBeTruthy();
    for (const id of ["issue-1", "issue-2"]) {
      const cell = screen.getByTestId(`yunxiao-issue-actions-${id}`);
      const buttons = Array.from(cell.querySelectorAll("button"));
      expect(buttons.map((b) => b.textContent?.trim())).toEqual([
        "发起讨论",
        "加到计划",
        "直接开始",
      ]);
      // 前两个是次级（行悬停才现身），最后一个是常驻主操作且压在最右——
      // 悬停让次级现身时主操作不位移。
      for (const secondary of buttons.slice(0, 2)) {
        expect(secondary.className).toContain("row-actions-secondary");
      }
      expect(buttons[2].className).toBe("row-actions-btn");
      expect(buttons[2].dataset.tone).toBe("primary");
      expect(cell.lastElementChild).toBe(buttons[2]);
    }
    expect(screen.queryByRole("button", { name: /更多操作/ })).toBeNull();
  });

  it("「发起讨论」与「加到计划」一次点击直达（无需先展开菜单）", async () => {
    const user = userEvent.setup();
    const { onDiscuss, onAddToPlan } = renderList();

    const first = await screen.findByTestId("yunxiao-issue-actions-issue-1");
    await user.click(within(first).getByRole("button", { name: "发起讨论" }));
    expect(onDiscuss).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-1" }));

    const second = screen.getByTestId("yunxiao-issue-actions-issue-2");
    await user.click(within(second).getByRole("button", { name: "加到计划" }));
    expect(onAddToPlan).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-2" }));
  });

  it("多选模式下行内动作整体收起，交给底部动作条", async () => {
    renderList({ selectionMode: true });

    expect(await screen.findByText("议题 1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /直接开始/ })).toBeNull();
    expect(screen.queryByTestId("yunxiao-issue-actions-issue-1")).toBeNull();
  });
});
