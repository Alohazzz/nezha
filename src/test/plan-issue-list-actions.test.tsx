import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryPlan, Plan, PlanIssue, Project, Task } from "../types";
import { PlanPanel } from "../components/delivery-plan/PlanPanel";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();
const openUrlMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

// 议题表里没有 Radix 组件，但 PlanLaunchDialog 内的「关联方案」下拉若渲染会用到这里。
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
    projectId: "proj-1",
  },
};

const project: Project = { id: "p1", name: "HIS", path: "H:/Project", lastOpenedAt: 1 };

function planIssue(n: number): PlanIssue {
  return { workitemId: `w-${n}`, serialNumber: `QHDK-3043${n}`, subject: `议题 ${n}` };
}

const deliveryPlan: DeliveryPlan = {
  id: "b1",
  projectId: "p1",
  name: "处方打印问题修复",
  kind: "fix",
  branch: "fix/处方打印问题修复",
  baseBranch: "master",
  targetBranch: "",
  issues: [planIssue(9), planIssue(8), planIssue(0)],
  status: "active",
  createdAt: Date.now(),
};

/** 落 draft 方案的桩：返回可供 PlanLaunchDialog 继续挂归属的 draft 对象。 */
function makeDraftPlan(): Plan {
  return {
    id: "draft-1",
    projectId: "p1",
    name: "",
    issues: [],
    status: "draft",
    createdAt: 0,
  };
}

function renderPanel(overrides: {
  tasks?: Task[];
  plans?: Plan[];
  onCreatePlan?: (projectId: string, issues: PlanIssue[]) => Plan;
  onStartPlanDiscussion?: () => void;
} = {}) {
  return render(
    <I18nProvider>
      <PlanPanel
        projects={[project]}
        tasks={overrides.tasks ?? []}
        plans={overrides.plans ?? []}
        deliveryPlans={[deliveryPlan]}
        onDeliveryPlansChange={() => undefined}
        onGoYunxiao={() => undefined}
        onStartDirectExecution={() => undefined}
        onCreatePlan={overrides.onCreatePlan ?? (() => makeDraftPlan())}
        onStartPlanDiscussion={overrides.onStartPlanDiscussion ?? (() => undefined)}
        onCancelPlan={() => undefined}
        onSetParentPlan={() => undefined}
      />
    </I18nProvider>,
  );
}

describe("计划详情议题表：云效链接 / 单条讨论 / 合并讨论", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nezha:language", "zh");
    invokeMock.mockReset();
    openUrlMock.mockClear();
    invokeMock.mockImplementation((command: string) => {
      if (command === "load_app_settings") return Promise.resolve(APP_SETTINGS);
      // 发起讨论对话框打开后会拉详情/图片。这里让它挂起：jsdom 里 invoke 是瞬时
      // resolve，而 PlanLaunchDialog 的拉取 worker 依赖「渲染间隙」推进队列，
      // 瞬时 resolve 会让它空转（真实 IPC 有往返延迟不会）。挂起即可稳定止步于拉取中。
      if (command === "yunxiao_get_workitem") return new Promise(() => {});
      if (command === "yunxiao_prepare_issue_images") return new Promise(() => {});
      if (command === "remove_delivery_plan_issue") {
        // 移出后后端回吐更新过的计划；w-8 被摘掉，其余保持。
        return Promise.resolve({
          ...deliveryPlan,
          issues: deliveryPlan.issues.filter((i) => i.workitemId !== "w-8"),
        });
      }
      return Promise.resolve(null);
    });
  });

  it("每行给出跳云效原议题的链接", async () => {
    const user = userEvent.setup();
    renderPanel();

    const link = await screen.findByLabelText("在云效打开 QHDK-30439");
    await user.click(link);

    expect(openUrlMock).toHaveBeenCalledWith(
      "https://devops.aliyun.com/projex/project/proj-1/workitem/w-9",
    );
  });

  it("行内动作是一次点击直达的文字按钮，不做二级菜单", async () => {
    const onCreatePlan = vi.fn<(projectId: string, issues: PlanIssue[]) => Plan>(
      () => makeDraftPlan(),
    );
    const user = userEvent.setup();
    renderPanel({ onCreatePlan });

    const cell = screen.getByTestId("plan-issue-actions-w-9");
    // 每行「次级动作 + 主操作」全在行内，没有「…」触发器 / 弹出菜单。
    const buttons = within(cell).getAllByRole("button");
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      "单条讨论",
      "移出计划",
      "直接开始",
    ]);
    expect(screen.queryByRole("button", { name: /更多操作/ })).toBeNull();

    // 前两个是次级（行悬停才现身），最后一个是常驻主操作且必须压在最右——
    // 悬停让次级现身时主操作不位移。
    for (const secondary of buttons.slice(0, 2)) {
      expect(secondary.className).toContain("row-actions-secondary");
    }
    expect(buttons[2].className).toBe("row-actions-btn");
    expect(buttons[2].dataset.tone).toBe("primary");
    expect(cell.lastElementChild).toBe(buttons[2]);
    expect(buttons[1].dataset.tone).toBe("danger");

    // 次级动作无需先展开菜单，直接点即可发起。
    await user.click(within(cell).getByRole("button", { name: "单条讨论" }));
    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledTimes(1));
    expect(onCreatePlan.mock.calls[0][1]).toEqual([
      { workitemId: "w-9", serialNumber: "QHDK-30439", subject: "议题 9", category: "" },
    ]);
  });

  it("单条讨论走与云效议题列表同一条发起链路（N=1）", async () => {
    const onCreatePlan = vi.fn<(projectId: string, issues: PlanIssue[]) => Plan>(
      () => makeDraftPlan(),
    );
    const user = userEvent.setup();
    renderPanel({ onCreatePlan });

    const discussButtons = await screen.findAllByRole("button", { name: "单条讨论" });
    await user.click(discussButtons[0]);

    // 对话框打开即落 draft 方案，议题快照只含这一条。
    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledTimes(1));
    expect(onCreatePlan.mock.calls[0][0]).toBe("p1");
    expect(onCreatePlan.mock.calls[0][1]).toEqual([
      { workitemId: "w-9", serialNumber: "QHDK-30439", subject: "议题 9", category: "" },
    ]);
    // 标题与「发起」按钮同名，用只在对话框里出现的补充标签确认弹窗已开。
    expect(await screen.findByText("讨论补充（可选）")).toBeTruthy();
  });

  it("移出计划由行内破坏性按钮直接触发", async () => {
    const user = userEvent.setup();
    renderPanel();

    const cell = screen.getByTestId("plan-issue-actions-w-8");
    await user.click(within(cell).getByRole("button", { name: "移出计划" }));

    // 直接接上既有的移出链路（后端移除后回吐更新过的计划）。
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "remove_delivery_plan_issue",
        expect.objectContaining({ workitemId: "w-8" }),
      ),
    );
  });

  it("勾选多条后「合并讨论」把整批议题合成一份方案", async () => {
    const onCreatePlan = vi.fn<(projectId: string, issues: PlanIssue[]) => Plan>(
      () => makeDraftPlan(),
    );
    const user = userEvent.setup();
    renderPanel({ onCreatePlan });

    // 勾选前没有动作条。
    expect(screen.queryByText(/已选/)).toBeNull();

    await user.click(await screen.findByLabelText("选择议题 QHDK-30439"));
    await user.click(screen.getByLabelText("选择议题 QHDK-30438"));

    expect(await screen.findByText("已选 2 项")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /合并讨论/ }));

    await waitFor(() => expect(onCreatePlan).toHaveBeenCalledTimes(1));
    // 顺序 = 勾选顺序（与云效议题列表一致）。
    expect(
      (onCreatePlan.mock.calls[0][1] as PlanIssue[]).map((i) => i.serialNumber),
    ).toEqual(["QHDK-30439", "QHDK-30438"]);
    // 发起后动作条收起。
    await waitFor(() => expect(screen.queryByText("已选 2 项")).toBeNull());
  });

  it("已被任务或存活方案占用的议题：勾选框禁用且不提供讨论入口", async () => {
    const occupiedTask = {
      id: "t1",
      projectId: "p1",
      prompt: "",
      agent: "claude",
      permissionMode: "ask",
      status: "running",
      createdAt: 1,
      yunxiaoWorkitemId: "w-9",
    } as Task;
    renderPanel({ tasks: [occupiedTask] });

    const box = (await screen.findByLabelText("选择议题 QHDK-30439")) as HTMLInputElement;
    expect(box).toBeDisabled();

    // 被占用行派生出「执行中」，没有主操作，只剩「移出计划」；讨论入口收起。
    const occupiedCell = screen.getByTestId("plan-issue-actions-w-9");
    expect(
      within(occupiedCell)
        .getAllByRole("button")
        .map((b) => b.textContent?.trim()),
    ).toEqual(["移出计划"]);
    // 自由议题仍有讨论入口。
    expect(screen.getAllByRole("button", { name: "单条讨论" })).toHaveLength(2);
  });
});
