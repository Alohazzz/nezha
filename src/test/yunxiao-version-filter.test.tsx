import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YunxiaoPage, YunxiaoVersion, YunxiaoWorkitem } from "../types";
import { I18nProvider } from "../i18n";
import { ToastProvider } from "../components/Toast";
import { YunxiaoView } from "../components/yunxiao/YunxiaoView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

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

const VERSIONS: YunxiaoVersion[] = [
  { id: "v-1", name: "v2.20260501.0", status: "DOING" },
  { id: "v-2", name: "v2.20260901.0", status: "TODO" },
];

function issue(id: number): YunxiaoWorkitem {
  return {
    id: `issue-${id}`,
    serialNumber: `REQ-${id}`,
    subject: `议题 ${id}`,
    customFieldValues: [],
  };
}

/** 取最近一次 yunxiao_search_workitems 调用解析出的 conditions（无则 undefined）。 */
function lastConditions(): string | undefined {
  const calls = invokeMock.mock.calls.filter(([cmd]) => cmd === "yunxiao_search_workitems");
  const last = calls[calls.length - 1];
  const args = last?.[1] as Record<string, unknown> | undefined;
  return args?.conditions as string | undefined;
}

describe("YunxiaoView 版本过滤", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "load_app_settings") return Promise.resolve(APP_SETTINGS);
      if (command === "yunxiao_search_projects") {
        return Promise.resolve<YunxiaoPage<{ id: string; name: string }>>({
          items: [{ id: "proj-1", name: "项目 1" }],
          total: 1,
          page: 1,
          perPage: 200,
        });
      }
      if (command === "yunxiao_list_workitem_statuses") return Promise.resolve([]);
      if (command === "yunxiao_list_versions") return Promise.resolve(VERSIONS);
      if (command === "yunxiao_search_workitems") {
        return Promise.resolve<YunxiaoPage<YunxiaoWorkitem>>({
          items: [issue(1)],
          total: 1,
          page: (args?.page as number) ?? 1,
          perPage: 100,
        });
      }
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("选择版本后以 version CONTAINS 条件重新请求，并按项目持久化", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ToastProvider>
          <YunxiaoView
            projects={[]}
            tasks={[]}
            onBack={vi.fn()}
            plans={[]}
            onCreatePlan={vi.fn()}
            onStartPlanDiscussion={vi.fn()}
            onStartDirectExecution={vi.fn()}
            onCancelPlan={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    // 版本下拉加载完成后触发器为「全部版本」（英文环境）。
    const trigger = await screen.findByLabelText("All versions");
    expect(trigger).toBeTruthy();

    await user.click(trigger);
    await user.click(await screen.findByText("v2.20260501.0"));

    // 防抖后重新请求，conditions 带 version 条件（fieldIdentifier 为单数）。
    await waitFor(
      () => {
        const conditions = lastConditions();
        expect(conditions).toBeTruthy();
        const parsed = JSON.parse(conditions!);
        expect(parsed.conditionGroups[0]).toEqual([
          {
            className: "version",
            fieldIdentifier: "version",
            format: "list",
            operator: "CONTAINS",
            toValue: null,
            value: ["v-1"],
          },
        ]);
      },
      { timeout: 4000 },
    );

    // 触发器显示已选数量。
    expect(await screen.findByText("1 versions")).toBeTruthy();

    // 过滤偏好按项目写入 localStorage。
    await waitFor(() => {
      const raw = localStorage.getItem("nezha:yunxiaoFilters:proj-1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).versionIds).toEqual(["v-1"]);
    });
  });
});
