import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanBoard } from "../components/yunxiao/plan/PlanBoard";
import { I18nProvider } from "../i18n";
import type { Plan, Task } from "../types";
import { parsePlanDeps } from "../utils/planDeps";

// 断言按中文文案；jsdom 的 navigator.language 默认是 en。
beforeEach(() => {
  localStorage.setItem("nezha:language", "zh");
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan1",
    projectId: "p1",
    name: "医保目录联合方案",
    issues: [
      { workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" },
      { workitemId: "w2", serialNumber: "QHDK-B", subject: "议题 B" },
    ],
    status: "executing",
    createdAt: 1,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "p1",
    prompt: "",
    agent: "claude",
    permissionMode: "ask",
    status: "todo",
    createdAt: 1,
    ...overrides,
  };
}

const DEPS = {
  plan1: parsePlanDeps(
    JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "QHDK-A", dependsOn: [] },
        { serialNumber: "QHDK-B", dependsOn: ["QHDK-A"] },
      ],
      executionOrder: ["QHDK-A", "QHDK-B"],
    }),
    ["QHDK-A", "QHDK-B"],
  ),
};

type BoardProps = React.ComponentProps<typeof PlanBoard>;

function renderBoard(props: Partial<BoardProps> = {}) {
  const handlers = {
    onPreview: vi.fn(),
    onOpenTask: vi.fn(),
    onComplete: vi.fn(),
    onReopen: vi.fn(),
    onCancel: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
    onDelete: vi.fn(),
  };
  const utils = render(
    <I18nProvider>
      <PlanBoard
        plans={[makePlan()]}
        tasks={[]}
        depsByPlanId={{}}
        projectNames={new Map([["p1", "demo"]])}
        projectPaths={new Map([["p1", "/workspace/demo"]])}
        {...handlers}
        {...props}
      />
    </I18nProvider>,
  );
  return Object.assign(utils, { handlers });
}

/** 表头是折叠开关（内容含方案名）。 */
function planHeader(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(title) });
}

describe("PlanBoard — 任务为主体的看板", () => {
  it("空方案列表显示空态", () => {
    renderBoard({ plans: [] });
    expect(screen.getByText(/暂无方案/)).toBeInTheDocument();
  });

  it("方案是可折叠分组表头：显示名称、生命周期、进度", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      ],
    });
    expect(screen.getByText("医保目录联合方案")).toBeInTheDocument();
    expect(screen.getByText("执行中")).toBeInTheDocument();
    expect(screen.getByText("已完成 1/2")).toBeInTheDocument();
  });

  it("展开后任务行是主体：编号 / 标题 / 状态，未生成待办的议题也列出", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t1",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "running",
        }),
      ],
      depsByPlanId: DEPS,
    });
    // 有 running 任务的方案默认展开
    const header = planHeader("医保目录联合方案");
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("议题 A")).toBeInTheDocument();
    expect(screen.getByText("运行中...")).toBeInTheDocument();
    // B 无任务 → 标为无任务
    expect(screen.getByText("议题 B")).toBeInTheDocument();
  });

  it("任务行显式展示前置约束（『任务之间的约束』的落点）", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t1",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "running",
        }),
      ],
      depsByPlanId: DEPS,
    });
    // A 在跑（方案默认展开）；B 依赖 A 且 A 未 done → 显示等待约束
    expect(screen.getByText(/等 QHDK-A/)).toBeInTheDocument();
  });

  it("前置已完成时显示『前置 X 已完成』", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t1",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "done",
        }),
      ],
      depsByPlanId: DEPS,
    });
    fireEvent.click(planHeader("医保目录联合方案"));
    expect(screen.getByText(/前置 QHDK-A 已完成/)).toBeInTheDocument();
  });

  it("前置任务缺失时标为前置异常（不静默放行）", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t2",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
        }),
      ],
      depsByPlanId: DEPS,
    });
    // waiting_deps 属 lively → 默认展开；A 无任务 → 前置异常
    expect(screen.getByText("等待前置")).toBeInTheDocument();
    expect(screen.getByText(/前置异常：QHDK-A/)).toBeInTheDocument();
  });

  it("组头汇总「等 N 项」约束数", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [],
      depsByPlanId: DEPS,
    });
    expect(screen.getByText("等 1 项")).toBeInTheDocument();
  });

  it("悬停表头后「标记完成」调 onComplete", () => {
    const utils = renderBoard({ plans: [makePlan({ status: "executing" })] });
    fireEvent.mouseEnter(planHeader("医保目录联合方案"));
    fireEvent.click(screen.getByRole("button", { name: /标记完成/ }));
    expect(utils.handlers.onComplete).toHaveBeenCalledWith("plan1");
  });

  it("讨论中的方案不出现「标记完成」，出现「取消方案」", () => {
    renderBoard({ plans: [makePlan({ status: "draft" })] });
    fireEvent.mouseEnter(planHeader("医保目录联合方案"));
    expect(screen.queryByRole("button", { name: /标记完成/ })).toBeNull();
    expect(screen.getByRole("button", { name: /取消方案/ })).toBeInTheDocument();
  });

  it("已完成方案出现「重开」与「归档」", () => {
    const utils = renderBoard({ plans: [makePlan({ status: "completed" })] });
    fireEvent.mouseEnter(planHeader("医保目录联合方案"));
    fireEvent.click(screen.getByRole("button", { name: /重开/ }));
    expect(utils.handlers.onReopen).toHaveBeenCalledWith("plan1");
    expect(screen.getByRole("button", { name: /归档/ })).toBeInTheDocument();
  });

  it("全部议题完成且执行中时表头出现「可标记完成」提示", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
        makeTask({ id: "t2", planId: "plan1", yunxiaoSerialNumber: "QHDK-B", status: "done" }),
      ],
    });
    expect(screen.getByText("议题全部完成，可标记完成")).toBeInTheDocument();
  });

  it("归档方案移出主视图，进入已归档区并可反归档", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "completed", archivedAt: 5 })],
    });
    expect(screen.queryByText("已完成 0/2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("button", { name: /取消归档/ }));
    expect(utils.handlers.onUnarchive).toHaveBeenCalledWith("plan1");
  });

  it("点击任务行的跳转按钮调 onOpenTask", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t1",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "running",
        }),
      ],
      depsByPlanId: DEPS,
    });
    const subject = screen.getByText("议题 A");
    const row = subject.closest("div");
    expect(row).not.toBeNull();
    fireEvent.click(within(row as HTMLElement).getByRole("button", { name: /打开任务/ }));
    expect(utils.handlers.onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("跨项目分组：两个项目各渲染一个区块", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", projectId: "p1" }),
        makePlan({ id: "b", projectId: "p2", name: "另一个方案" }),
      ],
      projectNames: new Map([
        ["p1", "demo"],
        ["p2", "other"],
      ]),
    });
    expect(screen.getByText("demo")).toBeInTheDocument();
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("筛选框按方案名过滤", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "医保目录联合方案" }),
        makePlan({ id: "b", name: "处方回写方案" }),
      ],
    });
    fireEvent.change(screen.getByPlaceholderText(/筛选方案或项目/), {
      target: { value: "处方" },
    });
    expect(screen.queryByText("医保目录联合方案")).toBeNull();
    expect(screen.getByText("处方回写方案")).toBeInTheDocument();
  });

  it("方案状态多选过滤：选中态只留下该状态的方案", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "讨论中的方案", status: "draft" }),
        makePlan({ id: "b", name: "执行中的方案", status: "executing" }),
      ],
    });
    expect(screen.getByText("讨论中的方案")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("方案状态"));
    fireEvent.click(screen.getByLabelText("执行中"));
    expect(screen.queryByText("讨论中的方案")).toBeNull();
    expect(screen.getByText("执行中的方案")).toBeInTheDocument();
    expect(screen.getByText("方案状态：1")).toBeInTheDocument();
  });

  it("状态过滤可多选（并集），清空后恢复全部", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "讨论中的方案", status: "draft" }),
        makePlan({ id: "b", name: "执行中的方案", status: "executing" }),
        makePlan({ id: "c", name: "已完成的方案", status: "completed" }),
      ],
    });
    const input = screen.getByPlaceholderText(/筛选方案或项目/);
    const trigger = screen.getByLabelText("方案状态");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByLabelText("讨论中"));
    fireEvent.click(screen.getByLabelText("执行中"));
    expect(screen.getByText("讨论中的方案")).toBeInTheDocument();
    expect(screen.getByText("执行中的方案")).toBeInTheDocument();
    expect(screen.queryByText("已完成的方案")).toBeNull();
    // 多选与文本筛选可叠加（「已完成的方案」同时被两个条件排除）
    fireEvent.change(input, { target: { value: "方案" } });
    expect(screen.getByText("讨论中的方案")).toBeInTheDocument();
    expect(screen.queryByText("已完成的方案")).toBeNull();
    fireEvent.change(input, { target: { value: "执行" } });
    expect(screen.queryByText("讨论中的方案")).toBeNull();
    expect(screen.getByText("执行中的方案")).toBeInTheDocument();
    // 清空状态下拉后文本筛选仍然生效（两个筛选器互不干扰）
    fireEvent.click(screen.getByText("清空"));
    expect(screen.queryByText("讨论中的方案")).toBeNull();
    expect(screen.getByText("执行中的方案")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByText("讨论中的方案")).toBeInTheDocument();
    expect(screen.getByText("已完成的方案")).toBeInTheDocument();
  });

  it("「仅看进行中」只留下有任务在动的方案", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "有任务在跑", issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" }] }),
        makePlan({ id: "b", name: "完全静止", issues: [{ workitemId: "w2", serialNumber: "QHDK-B", subject: "议题 B" }] }),
      ],
      tasks: [
        makeTask({
          id: "t1",
          planId: "a",
          yunxiaoSerialNumber: "QHDK-A",
          status: "running",
        }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "仅看进行中" }));
    expect(screen.getByText("有任务在跑")).toBeInTheDocument();
    expect(screen.queryByText("完全静止")).toBeNull();
    // 再点一次取消该筛选
    fireEvent.click(screen.getByRole("button", { name: "仅看进行中" }));
    expect(screen.getByText("完全静止")).toBeInTheDocument();
  });

  it("筛选无结果时显示空态并可清除筛选", () => {
    renderBoard({
      plans: [makePlan({ id: "a", name: "医保目录联合方案" })],
    });
    fireEvent.change(screen.getByPlaceholderText(/筛选方案或项目/), {
      target: { value: "不存在的方案" },
    });
    expect(screen.getByText("没有符合筛选条件的方案")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(screen.getByText("医保目录联合方案")).toBeInTheDocument();
    expect(screen.queryByText("没有符合筛选条件的方案")).toBeNull();
  });
});
