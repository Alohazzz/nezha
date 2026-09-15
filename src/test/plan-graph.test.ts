import { describe, expect, it } from "vitest";
import type { PlanTaskRow } from "../utils/planBoard";
import { parsePlanDeps } from "../utils/planDeps";
import {
  buildDependents,
  dependencyEdgeState,
  deriveUpstreamGraphNodes,
  layoutPlanDependencyGraph,
  planGraphNeighborhood,
  truncateToWidth,
} from "../utils/planGraph";
import type { Plan, Task } from "../types";

function row(serial: string, status: PlanTaskRow["status"] = null): PlanTaskRow {
  return {
    workitemId: `w-${serial}`,
    serialNumber: serial,
    subject: `${serial} 的标题`,
    task: null,
    status,
    statusSince: null,
    dependsOn: [],
    unmet: [],
    needsOverride: false,
  };
}

const deps = (graph: Record<string, string[]>) =>
  parsePlanDeps(
    JSON.stringify({
      version: 1,
      issues: Object.entries(graph).map(([serialNumber, dependsOn]) => ({
        serialNumber,
        dependsOn,
      })),
    }),
    Object.keys(graph),
  );

describe("planGraph — 依赖图布局", () => {
  it("无依赖时全部落在第 0 层，横向不散开", () => {
    const layout = layoutPlanDependencyGraph([row("A"), row("B")], undefined);
    expect(layout.layerCount).toBe(1);
    expect(layout.nodes.map((node) => node.layer)).toEqual([0, 0]);
    expect(layout.edges).toHaveLength(0);
  });

  it("分层 = 最长前置链长度（不是直接前置个数）", () => {
    // A → B → C 且 A → C：C 依赖 A、B，取最长链 → 第 2 层。
    const layout = layoutPlanDependencyGraph(
      [row("A"), row("B"), row("C")],
      deps({ A: [], B: ["A"], C: ["A", "B"] }),
    );
    const layerOf = new Map(layout.nodes.map((node) => [node.serialNumber, node.layer]));
    expect(layerOf.get("A")).toBe(0);
    expect(layerOf.get("B")).toBe(1);
    expect(layerOf.get("C")).toBe(2);
    expect(layout.layerCount).toBe(3);
  });

  it("列内 x 相同、逐层递增；列内按给定顺序自上而下", () => {
    const layout = layoutPlanDependencyGraph(
      [row("A"), row("B"), row("C")],
      deps({ A: [], B: ["A"], C: ["A"] }),
    );
    const bySerial = new Map(layout.nodes.map((node) => [node.serialNumber, node]));
    const a = bySerial.get("A") as NonNullable<ReturnType<typeof bySerial.get>>;
    const b = bySerial.get("B") as NonNullable<ReturnType<typeof bySerial.get>>;
    const c = bySerial.get("C") as NonNullable<ReturnType<typeof bySerial.get>>;
    expect(b.x).toBe(c.x); // 同层
    expect(b.x).toBeGreaterThan(a.x); // 下一层在右
    expect(b.y).toBeLessThan(c.y); // 列内顺序保留
  });

  it("边带前置状态：done=满足、missing/失败=异常、其余=未满足", () => {
    const layout = layoutPlanDependencyGraph(
      [row("A", "done"), row("B", "running"), row("C")],
      deps({ A: [], B: ["A"], C: ["A", "B"] }),
    );
    const stateOf = (from: string, to: string) =>
      layout.edges.find((edge) => edge.from === from && edge.to === to)?.state;
    expect(stateOf("A", "B")).toBe("satisfied");
    expect(stateOf("A", "C")).toBe("satisfied");
    expect(stateOf("B", "C")).toBe("unmet");
  });

  it("前置任务缺失或失败都算异常（与门禁口径一致）", () => {
    expect(dependencyEdgeState(null)).toBe("abnormal");
    expect(dependencyEdgeState(undefined)).toBe("abnormal");
    expect(dependencyEdgeState("failed")).toBe("abnormal");
    expect(dependencyEdgeState("cancelled")).toBe("abnormal");
    expect(dependencyEdgeState("interrupted")).toBe("abnormal");
    expect(dependencyEdgeState("todo")).toBe("unmet");
    expect(dependencyEdgeState("waiting_deps")).toBe("unmet");
    expect(dependencyEdgeState("done")).toBe("satisfied");
  });

  it("忽略图里指向方案外的编号，不产生悬空边", () => {
    const layout = layoutPlanDependencyGraph([row("A")], deps({ A: [] }));
    expect(layout.edges).toHaveLength(0);
  });

  it("内容尺寸随层数与列高增长", () => {
    const flat = layoutPlanDependencyGraph([row("A")], undefined);
    const deep = layoutPlanDependencyGraph([row("A"), row("B")], deps({ A: [], B: ["A"] }));
    expect(deep.width).toBeGreaterThan(flat.width);
  });

  it("相邻层边不需要通道（laneY 为空）", () => {
    const layout = layoutPlanDependencyGraph([row("A"), row("B")], deps({ A: [], B: ["A"] }));
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0].laneY).toBeUndefined();
  });

  it("跨层边分配到节点下方的专用通道（否则会横穿中间列的节点盒）", () => {
    // A(0) → B(1) → C(2)，且 A → C 跳过第 1 层：直线路由会从 B 的盒子里穿过去，
    // 语义上被读成「C 依赖了 B」。
    const layout = layoutPlanDependencyGraph(
      [row("A"), row("B"), row("C")],
      deps({ A: [], B: ["A"], C: ["A", "B"] }),
    );
    const layerOf = new Map(layout.nodes.map((n) => [n.serialNumber, n.layer]));
    expect(layerOf.get("C")).toBe(2); // 确认确实跨层

    const skipping = layout.edges.find((edge) => edge.from === "A" && edge.to === "C");
    expect(skipping?.laneY).toBeDefined();
    // 通道必须在所有节点下边框之下
    const lowest = Math.max(...layout.nodes.map((node) => node.y + node.height));
    expect(skipping?.laneY ?? 0).toBeGreaterThan(lowest);
    // 相邻层的边仍走直连，不占用通道
    expect(layout.edges.find((e) => e.from === "A" && e.to === "B")?.laneY).toBeUndefined();
  });

  it("多条跨层边各占一条通道且互不重叠", () => {
    // A→B→C→D 主链，外加 A→C(0→2)、A→D(0→3)、B→D(1→3) 三条跨层边。
    const layout = layoutPlanDependencyGraph(
      [row("A"), row("B"), row("C"), row("D")],
      deps({ A: [], B: ["A"], C: ["A", "B"], D: ["A", "B", "C"] }),
    );
    const lanes = layout.edges
      .filter((edge) => edge.laneY !== undefined)
      .map((edge) => edge.laneY as number);
    expect(lanes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(lanes).size).toBe(lanes.length);
  });

  it("有跨层边时内容高度包含通道区", () => {
    const skipping = layoutPlanDependencyGraph(
      [row("A"), row("B"), row("C")],
      deps({ A: [], B: ["A"], C: ["A"] }),
    );
    const lowestNode = Math.max(...skipping.nodes.map((n) => n.y + n.height));
    expect(skipping.height).toBeGreaterThan(lowestNode);
  });
});

describe("planGraph — 邻域与工具", () => {
  it("邻域包含自身 + 全部上游 + 全部下游（传递闭包）", () => {
    // A → B → C，且 A → D：从 B 出发应含 A（上游）、C（下游），不含 D。
    const graph = { A: [], B: ["A"], C: ["B"], D: ["A"] };
    const neighborhood = planGraphNeighborhood("B", graph);
    expect([...neighborhood].sort()).toEqual(["A", "B", "C"]);
  });

  it("成环时邻域收敛，不死循环", () => {
    const graph = { A: ["B"], B: ["A"] };
    const neighborhood = planGraphNeighborhood("A", graph);
    expect([...neighborhood].sort()).toEqual(["A", "B"]);
  });

  it("反向邻接表把边翻过来", () => {
    const reverse = buildDependents({ A: [], B: ["A"], C: ["A"] });
    expect(reverse.get("A")?.sort()).toEqual(["B", "C"]);
  });

  it("按像素宽度截断，超出加省略号", () => {
    expect(truncateToWidth("短标题", 200)).toBe("短标题");
    const long = truncateToWidth("这是一个非常非常非常长的议题标题需要被截断掉", 60);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThan("这是一个非常非常非常长的议题标题需要被截断掉".length);
  });
});

describe("planGraph — 上游方案议题作为外部节点（追加子方案的跨方案前置）", () => {
  /** 子方案 B1 依赖主方案 M1（跨方案边）。 */
  const childDeps = (
    serials: string[],
    graph: Record<string, string[]>,
    allowedExternal: string[] = ["QHDK-M1"],
  ) =>
    parsePlanDeps(
      JSON.stringify({
        version: 1,
        issues: Object.entries(graph).map(([serialNumber, dependsOn]) => ({
          serialNumber,
          dependsOn,
        })),
      }),
      serials,
      allowedExternal,
    );

  const upstream = [
    { serialNumber: "QHDK-M1", subject: "主方案议题 M1", planId: "main", planName: "主方案甲", status: "running" as const },
  ];

  it("跨方案前置画成第 0 层外部节点，依赖它的本方案议题落到第 1 层", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, upstream);
    const b1 = layout.nodes.find((n) => n.serialNumber === "QHDK-B1");
    const m1 = layout.nodes.find((n) => n.serialNumber === "QHDK-M1");
    expect(b1?.layer).toBe(1);
    expect(m1?.layer).toBe(0);
    expect(layout.layerCount).toBe(2);
  });

  it("外部节点带所属方案名，本方案议题不带", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, upstream);
    expect(layout.nodes.find((n) => n.serialNumber === "QHDK-M1")?.upstreamPlanName).toBe("主方案甲");
    expect(layout.nodes.find((n) => n.serialNumber === "QHDK-B1")?.upstreamPlanName).toBeUndefined();
  });

  it("跨方案边被画出，状态取上游任务状态（running → unmet 虚线）", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, upstream);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: "QHDK-M1", to: "QHDK-B1", state: "unmet" });
  });

  it("上游议题无任务（status null）→ 边按 abnormal 呈现，与门禁 missing 同口径", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, [
      { serialNumber: "QHDK-M1", subject: "M1", planId: "main", planName: "主方案甲", status: null },
    ]);
    expect(layout.edges[0].state).toBe("abnormal");
  });

  it("上游任务已完成 → satisfied", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, [
      { serialNumber: "QHDK-M1", subject: "M1", planId: "main", planName: "主方案甲", status: "done" },
    ]);
    expect(layout.edges[0].state).toBe("satisfied");
  });

  it("只画被**直接**依赖的上游议题，未引用的上游方案议题不入图（不展开成跨方案全景）", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, [
      ...upstream,
      { serialNumber: "QHDK-M2", subject: "没人依赖的上游议题", planId: "main", planName: "主方案甲", status: "done" },
    ]);
    expect(layout.nodes.map((n) => n.serialNumber).sort()).toEqual(["QHDK-B1", "QHDK-M1"]);
  });

  it("不传 upstream 时行为不变：跨方案编号被忽略，子议题落第 0 层", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M1"] });
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB);
    expect(layout.nodes.map((n) => n.serialNumber)).toEqual(["QHDK-B1"]);
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodes[0].layer).toBe(0);
  });

  it("多个上游前置按编号排序，布局可复现", () => {
    const depsB = childDeps(["QHDK-B1"], { "QHDK-B1": ["QHDK-M2", "QHDK-M1"] }, [
      "QHDK-M1",
      "QHDK-M2",
    ]);
    const ups = [
      { serialNumber: "QHDK-M1", subject: "M1", planId: "main", planName: "主方案甲", status: "done" as const },
      { serialNumber: "QHDK-M2", subject: "M2", planId: "main", planName: "主方案甲", status: "running" as const },
    ];
    const layout = layoutPlanDependencyGraph([row("QHDK-B1")], depsB, undefined, ups);
    expect(layout.nodes.filter((n) => n.layer === 0).map((n) => n.serialNumber)).toEqual([
      "QHDK-M1",
      "QHDK-M2",
    ]);
  });
});

describe("deriveUpstreamGraphNodes（从依赖图 + 祖先链派生图外部节点）", () => {
  function makePlan(id: string, parentPlanId: string | undefined, serials: string[]): Plan {
    return {
      id,
      projectId: "p1",
      name: id,
      issues: serials.map((serialNumber) => ({
        workitemId: `wi-${serialNumber}`,
        serialNumber,
        subject: `${serialNumber} 标题`,
      })),
      status: "executing",
      parentPlanId,
      createdAt: 1,
    };
  }
  function makeTask(serialNumber: string, status: Task["status"]): Task {
    return {
      id: `t-${serialNumber}`,
      projectId: "p1",
      prompt: "p",
      agent: "claude",
      permissionMode: "ask",
      status,
      createdAt: 1,
      yunxiaoSerialNumber: serialNumber,
    };
  }

  const root = makePlan("root", undefined, ["QHDK-G1"]);
  const main = makePlan("main", "root", ["QHDK-P1", "QHDK-P2"]);
  const child = makePlan("child", "main", ["QHDK-B1"]);
  const plans = [root, main, child];
  const childDeps = parsePlanDeps(
    JSON.stringify({
      version: 1,
      issues: [{ serialNumber: "QHDK-B1", dependsOn: ["QHDK-P1", "QHDK-G1"] }],
    }),
    ["QHDK-B1"],
    ["QHDK-P1", "QHDK-P2", "QHDK-G1"],
  );

  it("只取被直接引用的祖先议题，并带上所属方案 id / 名称与任务状态", () => {
    const nodes = deriveUpstreamGraphNodes(child, plans, [makeTask("QHDK-P1", "done")], childDeps);
    expect(nodes.map((n) => n.serialNumber).sort()).toEqual(["QHDK-G1", "QHDK-P1"]);
    const p1 = nodes.find((n) => n.serialNumber === "QHDK-P1");
    expect(p1).toMatchObject({ planId: "main", planName: "main", status: "done" });
    // 祖父方案的议题同样可作前置（决策 D-b）
    expect(nodes.find((n) => n.serialNumber === "QHDK-G1")).toMatchObject({
      planId: "root",
      status: null,
    });
  });

  it("未被引用的祖先议题不入图（P2 没被依赖）", () => {
    const nodes = deriveUpstreamGraphNodes(child, plans, [], childDeps);
    expect(nodes.map((n) => n.serialNumber)).not.toContain("QHDK-P2");
  });

  it("无 deps 时返回空（不臆造外部节点）", () => {
    expect(deriveUpstreamGraphNodes(child, plans, [], undefined)).toEqual([]);
    expect(
      deriveUpstreamGraphNodes(child, plans, [], parsePlanDeps(null, ["QHDK-B1"])),
    ).toEqual([]);
  });

  it("根方案引用本方案内编号时不会产出外部节点", () => {
    const intra = parsePlanDeps(
      JSON.stringify({
        version: 1,
        issues: [{ serialNumber: "QHDK-B1", dependsOn: ["QHDK-B1"] }],
      }),
      ["QHDK-B1"],
    );
    expect(deriveUpstreamGraphNodes(child, plans, [], intra)).toEqual([]);
  });

  it("祖先链断裂（父方案已删）时不产出外部节点 —— 与解析侧丢弃越界编号同口径", () => {
    const orphan = makePlan("child", "gone", ["QHDK-B1"]);
    const nodes = deriveUpstreamGraphNodes(orphan, [orphan], [], childDeps);
    expect(nodes).toEqual([]);
  });
});
