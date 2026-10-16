import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YunxiaoPage, YunxiaoWorkitem } from "../types";
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

function issue(id: number): YunxiaoWorkitem {
  return {
    id: `issue-${id}`,
    serialNumber: `REQ-${id}`,
    subject: `议题 ${id}`,
    customFieldValues: [],
  };
}

/** yunxiao_search_workitems 的全部调用（按发生顺序）。 */
function searchCalls(): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "yunxiao_search_workitems")
    .map(([, args]) => args as Record<string, unknown>);
}

describe("YunxiaoView 计划完成时间过滤初始化", () => {
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
      if (command === "yunxiao_list_versions") return Promise.resolve([]);
      // 字段探测挂起不 resolve：模拟慢速 HTTP——首查不允许等待它。
      if (command === "yunxiao_find_custom_field_id") {
        return new Promise(() => undefined);
      }
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

  it("初始化首查即带已保存的计划完成时间条件（字段 ID 从 localStorage 恢复，不等探测）", async () => {
    localStorage.setItem(
      "nezha:yunxiaoFilters:proj-1",
      JSON.stringify({
        assignedToMe: false,
        statusIds: [],
        versionIds: [],
        products: [],
        planEndPreset: "week",
        planEndFieldId: "field-plan-end",
        productFieldId: "field-product",
      }),
    );

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
            onSetParentPlan={vi.fn()}
            onLocateTask={vi.fn()}
            onStartPlanExecution={vi.fn()}
            onRediscussIssue={vi.fn()}
            onResumeDiscussion={vi.fn()}
            onCancelIssuePlan={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    // 首查发出时探测仍挂起（mock 永不 resolve），conditions 必须已带 BETWEEN。
    await waitFor(() => {
      const calls = searchCalls();
      expect(calls.length).toBeGreaterThan(0);
      const conditions = calls[0].conditions as string;
      expect(conditions).toBeTruthy();
      const parsed = JSON.parse(conditions);
      expect(parsed.conditionGroups[0]).toEqual([
        {
          className: "date",
          fieldIdentifier: "field-plan-end",
          format: "input",
          operator: "BETWEEN",
          toValue: null,
          value: [expect.any(String), expect.any(String)],
        },
      ]);
    });

    // 过滤器 UI 直接显示已保存的「本周」。
    expect(await screen.findByText("This week")).toBeTruthy();
  });

  it("首次使用（无缓存）时首查等待探测完成，字段 ID 就位后一次到位带条件", async () => {
    // 本用例需要探测能 resolve,覆盖默认的挂起实现。
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "yunxiao_find_custom_field_id") {
        return Promise.resolve(
          args?.fieldName === "计划完成时间" ? "field-probed" : "field-probed-product",
        );
      }
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
      if (command === "yunxiao_list_versions") return Promise.resolve([]);
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

    localStorage.setItem(
      "nezha:yunxiaoFilters:proj-1",
      JSON.stringify({ planEndPreset: "week" }),
    );

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
            onSetParentPlan={vi.fn()}
            onLocateTask={vi.fn()}
            onStartPlanExecution={vi.fn()}
            onRediscussIssue={vi.fn()}
            onResumeDiscussion={vi.fn()}
            onCancelIssuePlan={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    // 首查等待探测：不存在「无条件先查一次」的请求,第一条就是带条件的。
    await waitFor(() => {
      const calls = searchCalls();
      expect(calls.length).toBeGreaterThan(0);
      const parsed = JSON.parse(calls[0].conditions as string);
      expect(parsed.conditionGroups[0]).toEqual([
        expect.objectContaining({
          className: "date",
          fieldIdentifier: "field-probed",
          operator: "BETWEEN",
        }),
      ]);
    });

    // 探测结果写回 localStorage 供下次挂载首查直用。
    await waitFor(() => {
      const raw = localStorage.getItem("nezha:yunxiaoFilters:proj-1");
      expect(raw).toBeTruthy();
      expect(JSON.parse(raw!).planEndFieldId).toBe("field-probed");
    });
  });

  it("字段探测失败时不阻塞列表：放行首查（无时间条件）并正常渲染", async () => {
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "yunxiao_find_custom_field_id") {
        return Promise.reject(new Error("network down"));
      }
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
      if (command === "yunxiao_list_versions") return Promise.resolve([]);
      if (command === "yunxiao_search_workitems") {
        return Promise.resolve<YunxiaoPage<YunxiaoWorkitem>>({
          items: [issue(7)],
          total: 1,
          page: (args?.page as number) ?? 1,
          perPage: 100,
        });
      }
      return Promise.resolve(null);
    });

    localStorage.setItem(
      "nezha:yunxiaoFilters:proj-1",
      JSON.stringify({ planEndPreset: "week" }),
    );

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
            onSetParentPlan={vi.fn()}
            onLocateTask={vi.fn()}
            onStartPlanExecution={vi.fn()}
            onRediscussIssue={vi.fn()}
            onResumeDiscussion={vi.fn()}
            onCancelIssuePlan={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    // 探测失败后放行:列表仍能加载（无时间条件，过滤器此时不展示）。
    expect(await screen.findByText("议题 7")).toBeTruthy();
    const calls = searchCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].conditions).toBeUndefined();
  });
});
