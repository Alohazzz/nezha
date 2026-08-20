import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YunxiaoPage, YunxiaoProject, YunxiaoWorkitem } from "../types";
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

const PROJECTS: YunxiaoProject[] = [
  { id: "proj-1", name: "项目 1" },
  { id: "proj-2", name: "项目 2" },
  { id: "proj-3", name: "项目 3" },
];

const APP_SETTINGS = {
  yunxiao: {
    token: "pt-test",
    organizationId: "org-1",
    organizationName: "组织一",
    projectId: "proj-1",
    projectName: "项目 1",
    currentUserId: "user-1",
    currentUserName: "用户一",
  },
};

function issue(id: number): YunxiaoWorkitem {
  return {
    id: `issue-${id}`,
    serialNumber: `REQ-${id}`,
    subject: `议题 ${id}`,
    customFieldValues: [],
  };
}

describe("YunxiaoView 议题区项目切换", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "load_app_settings") {
        return Promise.resolve(APP_SETTINGS);
      }
      if (command === "yunxiao_search_projects") {
        return Promise.resolve<YunxiaoPage<YunxiaoProject>>({
          items: PROJECTS,
          total: PROJECTS.length,
          page: (args?.page as number) ?? 1,
          perPage: (args?.perPage as number) ?? 200,
        });
      }
      if (command === "yunxiao_search_workitems") {
        return Promise.resolve<YunxiaoPage<YunxiaoWorkitem>>({
          items: [issue(1)],
          total: 1,
          page: (args?.page as number) ?? 1,
          perPage: 100,
        });
      }
      if (command === "yunxiao_list_workitem_statuses") {
        return Promise.resolve([]);
      }
      if (command === "save_yunxiao_settings") {
        return Promise.resolve({ yunxiao: args });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("议题区可直接通过下拉切换云效项目并重新加载议题", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ToastProvider>
          <YunxiaoView projects={[]} tasks={[]} onBack={vi.fn()} onImportIssue={vi.fn()} />
        </ToastProvider>
      </I18nProvider>,
    );

    // 配置完成后：项目下拉直接展示当前项目，无需进入设置。
    const trigger = await screen.findByLabelText("项目 1");
    expect(trigger).toBeTruthy();

    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "项目 2" }));

    // 切换后持久化新的项目选择。
    await waitFor(() => {
      const saveCall = invokeMock.mock.calls.find(([cmd]) => cmd === "save_yunxiao_settings");
      expect(saveCall).toBeTruthy();
      const args = saveCall?.[1] as Record<string, unknown>;
      expect(args.projectId).toBe("proj-2");
      expect(args.projectName).toBe("项目 2");
    });

    // 议题按新项目重新加载。
    await waitFor(() => {
      const searchCalls = invokeMock.mock.calls.filter(
        ([cmd]) => cmd === "yunxiao_search_workitems",
      );
      const last = searchCalls[searchCalls.length - 1];
      expect(last).toBeTruthy();
      const args = last?.[1] as Record<string, unknown>;
      expect(args.projectId).toBe("proj-2");
    });

    // 下拉展示新项目。
    expect(await screen.findByLabelText("项目 2")).toBeTruthy();
  });
});
