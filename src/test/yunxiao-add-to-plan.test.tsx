import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, YunxiaoPage, YunxiaoWorkitem } from "../types";
import { I18nProvider } from "../i18n";
import { ToastProvider } from "../components/Toast";
import { YunxiaoView } from "../components/yunxiao/YunxiaoView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

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

const PROJECTS: Project[] = [
  { id: "local-1", name: "HIS", path: "/tmp/his", lastOpenedAt: 1 },
];

function issue(id: number): YunxiaoWorkitem {
  return {
    id: `issue-${id}`,
    serialNumber: `QHDK-${id}`,
    subject: `议题 ${id}`,
    customFieldValues: [],
  };
}

/** 当前服务端返回的议题集合，测试中途改小模拟「刷新/筛选后列表收缩」。 */
let serverItems: YunxiaoWorkitem[] = [];

describe("YunxiaoView 添加到计划：勾选数与加入数一致", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nezha:yunxiaoLastProjectId", "local-1");
    serverItems = [issue(1), issue(2), issue(3)];
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
      if (command === "yunxiao_search_workitems") {
        return Promise.resolve<YunxiaoPage<YunxiaoWorkitem>>({
          items: serverItems,
          total: serverItems.length,
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

  it("列表在勾选后收缩时，弹窗仍应带上全部 3 个已勾选议题", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <ToastProvider>
          <YunxiaoView
            projects={PROJECTS}
            tasks={[]}
            plans={[]}
            onBack={vi.fn()}
            onCreatePlan={vi.fn()}
            onStartPlanDiscussion={vi.fn()}
            onStartDirectExecution={vi.fn()}
            onCancelPlan={vi.fn()}
            onSetParentPlan={vi.fn()}
          />
        </ToastProvider>
      </I18nProvider>,
    );

    // 三条议题全部勾选。
    const boxes = await screen.findAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) {
      await user.click(box);
    }
    expect(await screen.findByText("3 selected")).toBeTruthy();

    // 刷新：服务端返回收缩为 1 条（等价于用户改筛选 / 切分类 / 点刷新后的列表）。
    serverItems = [issue(1)];
    await user.click(screen.getByLabelText("Refresh"));
    await waitFor(() => {
      expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    });

    // 仍未取消勾选：底部计数仍是 3。
    expect(await screen.findByText("3 selected")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "添加到计划" }));

    // 症状回归：弹窗必须带上全部 3 个已勾选议题，而不是「已勾选 ∩ 当前列表」的 1 个。
    expect(await screen.findByText(/将加入 3 个议题/)).toBeTruthy();
    expect(await screen.findByText(/QHDK-1、QHDK-2、QHDK-3/)).toBeTruthy();
  });
});
