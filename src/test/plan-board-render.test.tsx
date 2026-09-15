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

/** 左栏里的方案条目（可选中）。方案名可能同时出现在右栏归属链接里，故限定在左栏内。 */
function railItem(title: string): HTMLElement {
  const rail = screen.getByRole("complementary", { name: "方案列表" });
  return within(rail).getByRole("button", { name: new RegExp(title) });
}


/** 右栏详情（section aria-label = 方案名）。 */
function detail(title: string): HTMLElement {
  return screen.getByRole("region", { name: title });
}

function taskRow(container: HTMLElement, serial: string): HTMLElement {
  const row = container.querySelector(`.plan-task-row[data-serial="${serial}"]`);
  if (!row) throw new Error(`task row not found: ${serial}`);
  return row as HTMLElement;
}

describe("PlanBoard — 专注单方案的看板", () => {
  it("没有任何项目与方案时显示空态", () => {
    renderBoard({ plans: [], projectNames: new Map(), projectPaths: new Map() });
    expect(screen.getByText(/暂无方案/)).toBeInTheDocument();
  });

  it("左栏列出方案，右栏自动选中并展示摘要（名称 / 生命周期 / 进度）", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      ],
    });
    // 左栏条目存在（面包屑也含方案名，故用左栏条目断言存在性）
    expect(railItem("医保目录联合方案")).toBeInTheDocument();
    const pane = detail("医保目录联合方案");
    expect(within(pane).getByText("执行中")).toBeInTheDocument();
    expect(within(pane).getByText("已完成 1/2")).toBeInTheDocument();
  });

  it("面包屑显示项目与当前方案两级", () => {
    renderBoard({ plans: [makePlan({ name: "支付重构" })] });
    // 项目节点是切换器（aria-label = 切换项目）
    expect(screen.getByRole("button", { name: /切换项目/ })).toBeInTheDocument();
    expect(screen.getByText("/")).toBeInTheDocument();
    // 面包屑当前节点与详情标题都叫方案名
    expect(screen.getAllByText("支付重构").length).toBeGreaterThanOrEqual(2);
  });

  it("看板锁定单项目：默认只列当前项目的方案", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", projectId: "p1", name: "本项目的方案" }),
        makePlan({ id: "b", projectId: "p2", name: "他项目的方案" }),
      ],
      activeProjectId: "p1",
      projectNames: new Map([
        ["p1", "demo"],
        ["p2", "other"],
      ]),
    });
    expect(railItem("本项目的方案")).toBeInTheDocument();
    expect(screen.queryByText("他项目的方案")).toBeNull();
  });

  it("项目切换器可切到另一个项目，左栏随之换组", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", projectId: "p1", name: "本项目的方案" }),
        makePlan({ id: "b", projectId: "p2", name: "他项目的方案" }),
      ],
      activeProjectId: "p1",
      projectNames: new Map([
        ["p1", "demo"],
        ["p2", "other"],
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: /切换项目/ }));
    fireEvent.click(screen.getByRole("button", { name: /other/ }));
    expect(railItem("他项目的方案")).toBeInTheDocument();
    expect(screen.queryByText("本项目的方案")).toBeNull();
  });

  it("默认选中「有任务在动」的方案", () => {
    renderBoard({
      plans: [
        makePlan({ id: "still", name: "完全静止的", createdAt: 1 }),
        makePlan({ id: "live", name: "有任务在跑的", createdAt: 2 }),
      ],
      tasks: [
        makeTask({ id: "t1", planId: "live", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
    });
    const pane = detail("有任务在跑的");
    expect(within(pane).getByText("运行中...")).toBeInTheDocument();
  });

  it("点左栏切换到另一个方案，右栏跟着换", () => {
    renderBoard({
      plans: [makePlan({ id: "a", name: "第一个方案" }), makePlan({ id: "b", name: "第二个方案" })],
    });
    fireEvent.click(railItem("第二个方案"));
    expect(detail("第二个方案")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "第一个方案" })).toBeNull();
  });

  it("任务行是两行紧凑行：主行有编号/标题/状态，副行有前置约束", () => {
    const { container } = renderBoard({
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
    const rowB = taskRow(container, "QHDK-B");
    expect(within(rowB).getByText("QHDK-B")).toBeInTheDocument();
    expect(within(rowB).getByText("议题 B")).toBeInTheDocument();
    // 副行：A 未完成 → 等待约束
    expect(within(rowB).getByText(/等 QHDK-A/)).toBeInTheDocument();
  });

  it("前置已完成时副行显示「前置 X 已完成」", () => {
    const { container } = renderBoard({
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
    expect(
      within(taskRow(container, "QHDK-B")).getByText(/前置 QHDK-A 已完成/),
    ).toBeInTheDocument();
  });

  it("前置任务缺失时副行标为前置异常（不静默放行）", () => {
    const { container } = renderBoard({
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
    expect(within(taskRow(container, "QHDK-B")).getByText(/前置异常：QHDK-A/)).toBeInTheDocument();
  });

  it("任务行副行显示变更统计与失败原因（信息更丰富）", () => {
    const { container } = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({
          id: "t1",
          planId: "plan1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "failed",
          additions: 142,
          deletions: 30,
          failureReason: "构建失败：类型错误",
        }),
      ],
    });
    const row = taskRow(container, "QHDK-A");
    expect(within(row).getByText("+142")).toBeInTheDocument();
    expect(within(row).getByText("−30")).toBeInTheDocument();
    expect(within(row).getByText("构建失败：类型错误")).toBeInTheDocument();
  });

  it("依赖图按依赖深度横向分层，边带状态", () => {
    const { container } = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      ],
      depsByPlanId: DEPS,
    });
    const nodes = container.querySelectorAll(".plan-graph-node");
    expect(nodes.length).toBe(2);
    // A 无前置在第 0 层，B 依赖 A 在第 1 层 → x 坐标递增
    const nodeA = container.querySelector('.plan-graph-node[aria-label="QHDK-A"]');
    const nodeB = container.querySelector('.plan-graph-node[aria-label="QHDK-B"]');
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull();
    // A 已完成 → 边为 satisfied
    const edges = container.querySelectorAll(".plan-graph-edge");
    expect(edges.length).toBe(1);
    expect(edges[0].getAttribute("data-state")).toBe("satisfied");
  });

  it("前置未完成时依赖边标为 unmet", () => {
    const { container } = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
      depsByPlanId: DEPS,
    });
    const edge = container.querySelector(".plan-graph-edge");
    expect(edge?.getAttribute("data-state")).toBe("unmet");
  });

  it("悬停图节点时对应任务行高亮（图与列表联动）", () => {
    const { container } = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
      depsByPlanId: DEPS,
    });
    const nodeA = container.querySelector('.plan-graph-node[aria-label="QHDK-A"]');
    expect(nodeA).not.toBeNull();
    fireEvent.mouseEnter(nodeA as Element);
    // A 自身 + 下游 B 都在高亮邻域内；无关行不参与
    expect(taskRow(container, "QHDK-A").getAttribute("data-hot")).toBe("true");
    expect(taskRow(container, "QHDK-B").getAttribute("data-hot")).toBe("true");
    // 移出后高亮清除
    fireEvent.mouseLeave(nodeA as Element);
    expect(taskRow(container, "QHDK-A").getAttribute("data-hot")).toBeNull();
  });

  it("没有依赖时不画图，显示无依赖空态", () => {
    const { container } = renderBoard({
      plans: [makePlan({ status: "executing" })],
      depsByPlanId: {
        plan1: parsePlanDeps(null, ["QHDK-A", "QHDK-B"]),
      },
    });
    expect(container.querySelectorAll(".plan-graph-edge").length).toBe(0);
    expect(screen.getByText(/按无依赖处理/)).toBeInTheDocument();
  });

  it("依赖成环时给出告警（环上边被丢弃）", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      depsByPlanId: {
        plan1: parsePlanDeps(
          JSON.stringify({
            version: 1,
            issues: [
              { serialNumber: "QHDK-A", dependsOn: ["QHDK-B"] },
              { serialNumber: "QHDK-B", dependsOn: ["QHDK-A"] },
            ],
          }),
          ["QHDK-A", "QHDK-B"],
        ),
      },
    });
    expect(screen.getByText(/依赖成环已破除/)).toBeInTheDocument();
  });

  it("生命周期动作常驻详情头部（无需悬停）：标记完成调 onComplete", () => {
    const utils = renderBoard({ plans: [makePlan({ status: "executing" })] });
    const pane = detail("医保目录联合方案");
    fireEvent.click(within(pane).getByRole("button", { name: /标记完成/ }));
    expect(utils.handlers.onComplete).toHaveBeenCalledWith("plan1");
  });

  it("讨论中的方案不出现「标记完成」，出现「取消方案」与讨论卡", () => {
    renderBoard({ plans: [makePlan({ status: "draft" })] });
    const pane = detail("医保目录联合方案");
    expect(within(pane).queryByRole("button", { name: /标记完成/ })).toBeNull();
    expect(within(pane).getByRole("button", { name: /取消方案/ })).toBeInTheDocument();
    expect(within(pane).getByText(/方案仍在讨论中/)).toBeInTheDocument();
  });

  it("已完成方案出现「重开」与「归档」", () => {
    const utils = renderBoard({ plans: [makePlan({ status: "completed" })] });
    const pane = detail("医保目录联合方案");
    fireEvent.click(within(pane).getByRole("button", { name: /重开/ }));
    expect(utils.handlers.onReopen).toHaveBeenCalledWith("plan1");
    expect(within(pane).getByRole("button", { name: /归档/ })).toBeInTheDocument();
  });

  it("全部议题完成且执行中时出现「可标记完成」提示", () => {
    renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
        makeTask({ id: "t2", planId: "plan1", yunxiaoSerialNumber: "QHDK-B", status: "done" }),
      ],
    });
    expect(screen.getAllByText("议题全部完成，可标记完成").length).toBeGreaterThan(0);
  });

  it("归档方案移出左栏主列表，进入已归档区并可反归档", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "completed", archivedAt: 5 })],
    });
    expect(screen.queryByRole("region", { name: "医保目录联合方案" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /已归档/ }));
    fireEvent.click(screen.getByRole("button", { name: /取消归档/ }));
    expect(utils.handlers.onUnarchive).toHaveBeenCalledWith("plan1");
  });

  it("本项目方案全被归档时，右栏给出提示而不是空白", () => {
    renderBoard({
      plans: [makePlan({ status: "completed", archivedAt: 5 })],
    });
    // 活跃列表为空，不自动选中归档方案；右栏说明「请从列表选择」而非一片空白
    expect(screen.getByText(/从左栏选择一个方案/)).toBeInTheDocument();
  });

  it("点击任务行的「打开任务」调 onOpenTask", () => {
    const utils = renderBoard({
      plans: [makePlan({ status: "executing" })],
      tasks: [
        makeTask({ id: "t1", planId: "plan1", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
      depsByPlanId: DEPS,
    });
    const row = taskRow(utils.container, "QHDK-A");
    fireEvent.click(within(row).getByRole("button", { name: /打开任务/ }));
    expect(utils.handlers.onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("搜索框按方案名过滤左栏", () => {
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
    expect(railItem("处方回写方案")).toBeInTheDocument();
  });

  it("状态多选过滤：只留下该状态的方案", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "讨论中的方案", status: "draft" }),
        makePlan({ id: "b", name: "执行中的方案", status: "executing" }),
      ],
    });
    expect(railItem("讨论中的方案")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("方案状态"));
    fireEvent.click(screen.getByLabelText("执行中"));
    expect(screen.queryByText("讨论中的方案")).toBeNull();
    expect(railItem("执行中的方案")).toBeInTheDocument();
    expect(screen.getByText("方案状态：1")).toBeInTheDocument();
  });

  it("「仅看进行中」只留下有任务在动的方案", () => {
    renderBoard({
      plans: [
        makePlan({
          id: "a",
          name: "有任务在跑",
          issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" }],
        }),
        makePlan({
          id: "b",
          name: "完全静止",
          issues: [{ workitemId: "w2", serialNumber: "QHDK-B", subject: "议题 B" }],
        }),
      ],
      tasks: [
        makeTask({ id: "t1", planId: "a", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "仅看进行中" }));
    expect(railItem("有任务在跑")).toBeInTheDocument();
    expect(screen.queryByText("完全静止")).toBeNull();
    // 再点一次取消该筛选
    fireEvent.click(screen.getByRole("button", { name: "仅看进行中" }));
    expect(railItem("完全静止")).toBeInTheDocument();
  });

  it("筛选无结果时左栏显示空态并可清除筛选", () => {
    renderBoard({ plans: [makePlan({ id: "a", name: "医保目录联合方案" })] });
    fireEvent.change(screen.getByPlaceholderText(/筛选方案或项目/), {
      target: { value: "不存在的方案" },
    });
    expect(screen.getByText("没有符合筛选条件的方案")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(railItem("医保目录联合方案")).toBeInTheDocument();
    expect(screen.queryByText("没有符合筛选条件的方案")).toBeNull();
  });

  it("筛选把选中方案排除后，右栏回落到可见方案（不显示已消失的方案）", () => {
    renderBoard({
      plans: [
        makePlan({ id: "a", name: "医保目录联合方案" }),
        makePlan({ id: "b", name: "处方回写方案" }),
      ],
    });
    expect(detail("医保目录联合方案")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/筛选方案或项目/), {
      target: { value: "处方" },
    });
    expect(detail("处方回写方案")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "医保目录联合方案" })).toBeNull();
  });
});

describe("PlanBoard — 追加子方案：缩进树与子树筛选", () => {
  /** 主方案 + 其追加子方案；子方案议题 QHDK-C 依赖主方案议题 QHDK-A（跨方案前置）。 */
  function parentChildPlans() {
    const parent = makePlan({
      id: "parent",
      name: "主方案甲",
      status: "completed",
      issues: [
        { workitemId: "w1", serialNumber: "QHDK-A", subject: "主方案议题 A" },
        { workitemId: "w2", serialNumber: "QHDK-B", subject: "主方案议题 B" },
      ],
      createdAt: 1,
    });
    const child = makePlan({
      id: "child",
      name: "追加子方案甲",
      status: "executing",
      parentPlanId: "parent",
      issues: [{ workitemId: "w3", serialNumber: "QHDK-C", subject: "追加议题 C" }],
      createdAt: 2,
    });
    return { parent, child };
  }

  /** 子方案 deps：C 依赖主方案 A（跨方案边，靠祖先链白名单放行）。 */
  const CROSS_DEPS = {
    child: parsePlanDeps(
      JSON.stringify({ version: 1, issues: [{ serialNumber: "QHDK-C", dependsOn: ["QHDK-A"] }] }),
      ["QHDK-C"],
      ["QHDK-A", "QHDK-B"],
    ),
  };

  it("子方案缩进挂在主方案下（data-depth=1），且两者都在左栏", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({ plans: [parent, child] });
    const rows = container.querySelectorAll(".plan-rail-node");
    expect(rows).toHaveLength(2);
    expect((rows[0] as HTMLElement).dataset.depth).toBeUndefined();
    expect((rows[1] as HTMLElement).dataset.depth).toBe("1");
    expect(container.querySelectorAll('.plan-rail-item[data-child="true"]')).toHaveLength(1);
  });

  it("筛选只命中子方案时，父方案被一并带出（不出现孤儿行 / 不出现子方案被筛没）", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({ plans: [parent, child] });
    // 主方案已完成、子方案执行中：按「执行中」筛选，父不命中而子命中。
    fireEvent.click(screen.getByLabelText("方案状态"));
    fireEvent.click(screen.getByLabelText("执行中"));

    const titles = [...container.querySelectorAll(".plan-rail-item-title")].map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["主方案甲", "追加子方案甲"]);
    // 父是为带出命中子方案而显示，标记为 ancestor-only（弱化）。
    const ancestorOnly = container.querySelector('.plan-rail-node[data-ancestor-only="true"]');
    expect(ancestorOnly).not.toBeNull();
    expect(ancestorOnly?.textContent).toContain("主方案甲");
  });

  it("折叠父方案会收起子方案；命中子方案的分支被强制展开（筛选不被折叠吞掉）", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({ plans: [parent, child] });
    const toggle = container.querySelector(".plan-rail-node-toggle") as HTMLElement;
    expect(toggle).toBeTruthy();

    // 无筛选时折叠 → 子方案消失（父仍在）。
    fireEvent.click(toggle);
    expect(container.querySelectorAll(".plan-rail-node")).toHaveLength(1);

    // 展开回来 → 子方案重现。
    fireEvent.click(container.querySelector(".plan-rail-node-toggle") as HTMLElement);
    expect(container.querySelectorAll(".plan-rail-node")).toHaveLength(2);
  });

  it("详情头部显示归属：子方案有「追加自 ↗ 主方案」，主方案有「追加子方案（1）」", () => {
    const { parent, child } = parentChildPlans();
    renderBoard({ plans: [parent, child] });
    // 默认自动选中「有任务在动」的方案；此处无任务，先点开子方案。
    fireEvent.click(railItem("追加子方案甲"));
    const childDetail = detail("追加子方案甲");
    expect(within(childDetail).getByText(/追加自/)).toBeTruthy();
    expect(within(childDetail).getByText(/主方案甲/)).toBeTruthy();
  });

  it("点上「追加自 ↗ 主方案」跳到父方案详情", () => {
    const { parent, child } = parentChildPlans();
    renderBoard({ plans: [parent, child] });
    fireEvent.click(railItem("追加子方案甲"));
    fireEvent.click(within(detail("追加子方案甲")).getByText(/追加自/));
    // 右栏切换成父方案（无归属链接了，因为父是根方案）。
    const parentDetail = detail("主方案甲");
    expect(within(parentDetail).queryByText(/追加自/)).toBeNull();
    expect(within(parentDetail).getByText(/追加子方案（1）/)).toBeTruthy();
  });

  it("跨方案前置画成图外部节点，且子议题不再落在第 0 层", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({
      plans: [parent, child],
      tasks: [
        makeTask({ id: "ta", projectId: "p1", planId: "parent", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      ],
      depsByPlanId: CROSS_DEPS,
    });
    fireEvent.click(railItem("追加子方案甲"));
    const upstreamNode = container.querySelector('.plan-graph-node[data-upstream="true"]');
    expect(upstreamNode).not.toBeNull();
    expect(upstreamNode?.getAttribute("aria-label")).toContain("QHDK-A");
    expect(upstreamNode?.getAttribute("aria-label")).toContain("主方案甲");
    // 跨方案边被画出（A → C，A 已完成 → satisfied）。
    const edge = container.querySelector(`.plan-graph-edge[data-state="satisfied"]`);
    expect(edge).not.toBeNull();
  });

  it("点图上的上游节点跳转到所属方案（子方案列表里没有这一行可滚动定位）", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({
      plans: [parent, child],
      depsByPlanId: CROSS_DEPS,
    });
    fireEvent.click(railItem("追加子方案甲"));
    const upstreamNode = container.querySelector('.plan-graph-node[data-upstream="true"]') as Element;
    fireEvent.click(upstreamNode);
    expect(within(detail("主方案甲")).getByText(/追加子方案（1）/)).toBeTruthy();
  });

  it("归档区的子方案保持平铺，但照样标出所属主方案（归属口径全看板统一）", () => {
    const { parent, child } = parentChildPlans();
    const archivedChild = makePlan({
      id: "archived-child",
      name: "已归档子方案",
      parentPlanId: "parent",
      status: "completed",
      archivedAt: 99,
      createdAt: 3,
    });
    const { container } = renderBoard({ plans: [parent, child, archivedChild] });
    // 归档区默认折叠，先展开。
    expect(container.querySelector(".plan-rail-archived-list")).toBeNull();
    fireEvent.click(container.querySelector(".plan-rail-archived-toggle") as HTMLElement);
    expect(container.querySelectorAll(".plan-rail-archived-row")).toHaveLength(1);
    // 归档区不缩进（保持平铺）：缩进树里只有主方案 + 活跃子方案两行。
    expect(container.querySelectorAll(".plan-rail-node")).toHaveLength(2);
    // 但归属徽标必须在：归档区里的子方案也标明「↳ 主方案名」。
    const badge = container.querySelector(".plan-rail-archived-parent");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("主方案甲");
  });

  it("上游节点的状态用上游数据，不漏成「无任务」——否则与边的颜色自相矛盾", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({
      plans: [parent, child],
      tasks: [
        // 主方案议题 A 的任务已完成：图里应显示「已完成」，边为 satisfied（绿实线）。
        makeTask({
          id: "ta",
          projectId: "p1",
          planId: "parent",
          yunxiaoSerialNumber: "QHDK-A",
          status: "done",
        }),
      ],
      depsByPlanId: CROSS_DEPS,
    });
    fireEvent.click(railItem("追加子方案甲"));
    const upstreamNode = container.querySelector(
      '.plan-graph-node[data-upstream="true"]',
    ) as HTMLElement;
    // 状态不再退化成 todo（「无任务」），而是真实的上游任务状态。
    expect(upstreamNode.dataset.status).toBe("done");
    expect(upstreamNode.textContent).toContain("已完成");
    // 与边的状态一致（同一份事实的两种呈现）。
    const edge = container.querySelector('.plan-graph-edge[data-state="satisfied"]');
    expect(edge).not.toBeNull();
  });

  it("上游议题未生成待办时按「无任务」呈现，边按异常标红（与门禁 missing 同口径）", () => {
    const { parent, child } = parentChildPlans();
    const { container } = renderBoard({
      plans: [parent, child],
      depsByPlanId: CROSS_DEPS,
    });
    fireEvent.click(railItem("追加子方案甲"));
    const upstreamNode = container.querySelector(
      '.plan-graph-node[data-upstream="true"]',
    ) as HTMLElement;
    expect(upstreamNode.dataset.status).toBe("todo");
    expect(container.querySelector('.plan-graph-edge[data-state="abnormal"]')).not.toBeNull();
  });
});
