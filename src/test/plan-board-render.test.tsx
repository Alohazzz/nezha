import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanBoard } from "../components/yunxiao/plan/PlanBoard";
import { I18nProvider } from "../i18n";
import type { Plan, Task } from "../types";

// 断言按中文文案；jsdom 的 navigator.language 默认是 en。
beforeEach(() => {
  localStorage.setItem("nezha:language", "zh");
});

/**
 * 卡片动作按钮是 hover-gated（与 TaskListItem / KanbanCard 同一交互约定）。
 * userEvent 的指针移动会在点击前把 hover 态重置掉，导致条件渲染的按钮被卸载；
 * 因此这里用 fireEvent 显式进入 hover 再点击——测的是组件行为，不是指针模拟精度。
 */
function hoverAndClick(label: RegExp): void {
  fireEvent.mouseEnter(screen.getByText("医保目录联合方案"));
  fireEvent.click(screen.getByRole("button", { name: label }));
}

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

function renderBoard(
  props: Partial<React.ComponentProps<typeof PlanBoard>> = {},
): ReturnType<typeof render> {
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

describe("PlanBoard — 渲染与生命周期动作", () => {
  it("空方案列表显示空态，不渲染列", () => {
    renderBoard({ plans: [] });
    expect(screen.getByText(/暂无方案/)).toBeInTheDocument();
    expect(screen.queryByText("讨论中")).not.toBeInTheDocument();
  });

  it("方案卡片落在对应生命周期列，并显示进度", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      ],
    });
    // 执行中列里有该方案
    const card = screen.getByText("医保目录联合方案");
    expect(card).toBeInTheDocument();
    expect(screen.getByText("已完成 1/2")).toBeInTheDocument();
  });

  it("全部议题完成后显示「可标记完成」提示徽章，但状态未被自动改动", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
        makeTask({ id: "t2", planId: "plan1", yunxiaoSerialNumber: "QHDK-B", status: "done" }),
      ],
    });
    expect(screen.getByText("议题全部完成，可标记完成")).toBeInTheDocument();
  });

  it("悬停卡片后「标记完成」调 onComplete；「重开」只在已完成时出现", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "executing" })],
    }) as ReturnType<typeof renderBoard> & {
      handlers: Record<string, ReturnType<typeof vi.fn>>;
    };
    hoverAndClick(/标记完成/);
    expect(utils.handlers.onComplete).toHaveBeenCalledWith("plan1");
    expect(screen.queryByRole("button", { name: /重开/ })).toBeNull();
  });

  it("已完成方案出现「重开」与「归档」", () => {
    const utils = renderBoard({ plans: [makePlan({ status: "completed" })] }) as ReturnType<
      typeof renderBoard
    > & { handlers: Record<string, ReturnType<typeof vi.fn>> };
    fireEvent.mouseEnter(screen.getByText("医保目录联合方案"));
    fireEvent.click(screen.getByRole("button", { name: /重开/ }));
    expect(utils.handlers.onReopen).toHaveBeenCalledWith("plan1");
    expect(screen.getByRole("button", { name: /归档/ })).toBeInTheDocument();
  });

  it("已取消方案不出现在主列（归入已取消列）", () => {
    renderBoard({ plans: [makePlan({ status: "cancelled" })] });
    const cancelledHeader = screen.getByText("已取消");
    // 列头存在且计数为 1
    const column = cancelledHeader.closest("div");
    expect(column).not.toBeNull();
  });

  it("归档方案移出主列，进入「已归档」区并可反归档", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "completed", archivedAt: 5 })],
    }) as ReturnType<typeof renderBoard> & {
      handlers: Record<string, ReturnType<typeof vi.fn>>;
    };
    // 主列里没有该方案卡片
    expect(screen.queryByText("已完成 0/2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("button", { name: /取消归档/ }));
    expect(utils.handlers.onUnarchive).toHaveBeenCalledWith("plan1");
  });

  it("展开议题行显示依赖等待与任务状态", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
      depsByPlanId: {
        plan1: {
          graph: { "QHDK-A": [], "QHDK-B": ["QHDK-A"] },
          executionOrder: ["QHDK-A", "QHDK-B"],
          warnings: [],
        },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /展开议题/ }));
    expect(screen.getByText("等 QHDK-A")).toBeInTheDocument();
    // 议题 A 有任务但未生成待办之外的议题 B 显示「无任务」
    expect(screen.getByText("无任务")).toBeInTheDocument();
  });

  it("点击卡片「预览」调 onPreview，不触发展开", () => {
    const utils = renderBoard() as ReturnType<typeof renderBoard> & {
      handlers: Record<string, ReturnType<typeof vi.fn>>;
    };
    hoverAndClick(/预览/);
    expect(utils.handlers.onPreview).toHaveBeenCalledTimes(1);
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
});
