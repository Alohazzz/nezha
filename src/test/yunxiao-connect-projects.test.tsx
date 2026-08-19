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

function pageResult(
  items: YunxiaoProject[],
  page: number,
  perPage: number,
  total: number,
): YunxiaoPage<YunxiaoProject> {
  return { items, total, page, perPage };
}

describe("YunxiaoView 连接配置：项目下拉列表", () => {
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
        if (page === 1) {
          return Promise.resolve(
            pageResult(Array.from({ length: 200 }, (_, i) => project(i + 1)), page, perPage, 250),
          );
        }
        if (page === 2) {
          return Promise.resolve(
            pageResult(
              Array.from({ length: 50 }, (_, i) => project(201 + i)),
              page,
              perPage,
              250,
            ),
          );
        }
        return Promise.resolve(pageResult([], page, perPage, 250));
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it(
    "组织项目超过单页上限（250 个）时下拉列表应包含全部项目",
    async () => {
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

      // 只有一个组织时会自动加载项目列表。
      await waitFor(() => expect(screen.getByLabelText("项目 1")).toBeTruthy());
      await user.click(screen.getByLabelText("项目 1"));

      const options = await screen.findAllByRole("option");
      expect(options).toHaveLength(250);
    },
    15_000,
  );

});
