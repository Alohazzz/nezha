import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YunxiaoPage, YunxiaoProject } from "../types";
import { I18nProvider } from "../i18n";
import { ToastProvider } from "../components/Toast";
import { YunxiaoView } from "../components/yunxiao/YunxiaoView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// jsdom 缺少 Radix Select 交互所需的 pointer capture API。
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

function project(id: number): YunxiaoProject {
  return { id: `proj-${id}`, name: `项目 ${id}` };
}

describe("YunxiaoView 连接配置：项目下拉滚动", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "load_app_settings") {
        return Promise.resolve({});
      }
      if (command === "yunxiao_list_organizations") {
        return Promise.resolve([{ id: "org-1", name: "组织一" }]);
      }
      if (command === "yunxiao_search_projects") {
        const page = (args?.page as number) ?? 1;
        const perPage = (args?.perPage as number) ?? 200;
        const items = Array.from({ length: 200 }, (_, i) => project(i + 1));
        const result: YunxiaoPage<YunxiaoProject> = {
          items,
          total: 200,
          page,
          perPage,
        };
        return Promise.resolve(result);
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("项目很多时下拉列表高度受限且可滚动", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ToastProvider>
          <YunxiaoView projects={[]} tasks={[]} onBack={vi.fn()} onImportIssue={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );

    await user.type(screen.getByPlaceholderText("pt-xxxx"), "pt-test");
    await user.click(screen.getByRole("button", { name: "Fetch organizations" }));
    await waitFor(() => expect(screen.getByLabelText("项目 1")).toBeTruthy());
    await user.click(screen.getByLabelText("项目 1"));

    // 当前打开的下拉（项目）是页面上唯一渲染的 select viewport。
    const viewport = await waitFor(() => {
      const node = document.querySelector("[data-radix-select-viewport]");
      expect(node).toBeTruthy();
      return node as HTMLElement;
    });

    // 高度受限 + 纵向可滚动，否则选项一多下拉会超出屏幕无法滚动。
    expect(viewport.style.maxHeight).toBe("320px");
    expect(viewport.style.overflowY).toBe("auto");
  });
});
