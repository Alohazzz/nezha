import { describe, expect, it } from "vitest";
import type { Plan, Task, TaskStatus } from "../types";
import { parsePlanDeps } from "../utils/planDeps";
import {
  buildTaskBySerial,
  buildWaitingBadges,
  countOccupiedSlots,
  evaluateTaskGate,
  hasFreeSlot,
  isDependencyAbnormal,
  isDependencySatisfied,
  orderWaitingQueue,
  resolveMaxConcurrent,
  selectAutoStart,
} from "../utils/planQueue";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    projectId: "proj",
    prompt: "p",
    agent: "claude",
    permissionMode: "ask",
    status: "todo" as TaskStatus,
    createdAt: 1,
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    projectId: "proj",
    name: "方案",
    issues: [
      { workitemId: "w1", serialNumber: "QHDK-A", subject: "A" },
      { workitemId: "w2", serialNumber: "QHDK-B", subject: "B" },
      { workitemId: "w3", serialNumber: "QHDK-C", subject: "C" },
    ],
    status: "executing",
    createdAt: 1,
    ...overrides,
  };
}

/** A → B → C 链式依赖。 */
const CHAIN = parsePlanDeps(
  JSON.stringify({
    version: 1,
    issues: [
      { serialNumber: "QHDK-A", dependsOn: [] },
      { serialNumber: "QHDK-B", dependsOn: ["QHDK-A"] },
      { serialNumber: "QHDK-C", dependsOn: ["QHDK-B"] },
    ],
    executionOrder: ["QHDK-A", "QHDK-B", "QHDK-C"],
  }),
  ["QHDK-A", "QHDK-B", "QHDK-C"],
);

describe("依赖满足/异常口径", () => {
  it("只有 done 算满足", () => {
    expect(isDependencySatisfied("done")).toBe(true);
    for (const s of ["todo", "pending", "running", "failed", "cancelled", "interrupted", undefined] as const) {
      expect(isDependencySatisfied(s)).toBe(false);
    }
  });

  it("failed / cancelled / interrupted 算异常", () => {
    expect(isDependencyAbnormal("failed")).toBe(true);
    expect(isDependencyAbnormal("cancelled")).toBe(true);
    expect(isDependencyAbnormal("interrupted")).toBe(true);
    expect(isDependencyAbnormal("todo")).toBe(false);
    expect(isDependencyAbnormal(undefined)).toBe(false);
  });
});

describe("evaluateTaskGate", () => {
  it("前置 done → 不再阻塞", () => {
    const bySerial = buildTaskBySerial([
      makeTask({ id: "ta", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
    ]);
    const gate = evaluateTaskGate("QHDK-B", CHAIN.graph, bySerial);
    expect(gate.blocked).toBe(false);
    expect(gate.unmet).toEqual([]);
    expect(gate.needsOverride).toEqual([]);
  });

  it("前置未 done → 阻塞且 unmet 列出编号", () => {
    const gate = evaluateTaskGate(
      "QHDK-B",
      CHAIN.graph,
      buildTaskBySerial([makeTask({ id: "ta", yunxiaoSerialNumber: "QHDK-A", status: "running" })]),
    );
    expect(gate.blocked).toBe(true);
    expect(gate.unmet).toEqual(["QHDK-A"]);
    expect(gate.needsOverride).toEqual([]);
  });

  it("前置任务缺失 → unmet + needsOverride（不静默放行）", () => {
    const gate = evaluateTaskGate("QHDK-B", CHAIN.graph, new Map());
    expect(gate.blocked).toBe(true);
    expect(gate.unmet).toEqual(["QHDK-A"]);
    expect(gate.needsOverride).toEqual(["QHDK-A"]);
  });

  it("前置异常 → needsOverride", () => {
    const bySerial = buildTaskBySerial([
      makeTask({ id: "ta", yunxiaoSerialNumber: "QHDK-A", status: "failed" }),
    ]);
    const gate = evaluateTaskGate("QHDK-B", CHAIN.graph, bySerial);
    expect(gate.needsOverride).toEqual(["QHDK-A"]);
  });

  it("无依赖议题不阻塞", () => {
    const gate = evaluateTaskGate("QHDK-A", CHAIN.graph, new Map());
    expect(gate.blocked).toBe(false);
    expect(gate.entries).toEqual([]);
  });
});

describe("countOccupiedSlots", () => {
  it("只数本项目、且只数活跃态（waiting_deps 不占槽）", () => {
    const tasks = [
      makeTask({ id: "t1", projectId: "p", status: "running" }),
      makeTask({ id: "t2", projectId: "p", status: "waiting_deps" }),
      makeTask({ id: "t3", projectId: "p", status: "done" }),
      makeTask({ id: "t4", projectId: "q", status: "running" }),
    ];
    expect(countOccupiedSlots(tasks, "p")).toBe(1);
    expect(countOccupiedSlots(tasks, "q")).toBe(1);
  });
});

describe("orderWaitingQueue", () => {
  it("按拓扑序排列（executionOrder 优先）", () => {
    const ordered = orderWaitingQueue(
      [
        makeTask({ id: "tc", yunxiaoSerialNumber: "QHDK-C", planId: "p1", createdAt: 1 }),
        makeTask({ id: "ta", yunxiaoSerialNumber: "QHDK-A", planId: "p1", createdAt: 3 }),
        makeTask({ id: "tb", yunxiaoSerialNumber: "QHDK-B", planId: "p1", createdAt: 2 }),
      ],
      new Map([["p1", makePlan()]]),
      { p1: CHAIN },
    );
    expect(ordered.map((t) => t.id)).toEqual(["ta", "tb", "tc"]);
  });

  it("同层按 createdAt 升序，再按 id（结果确定）", () => {
    // A、B 同层无依赖（用空图），比 createdAt
    const ordered = orderWaitingQueue(
      [
        makeTask({ id: "z", yunxiaoSerialNumber: "QHDK-B", planId: "p1", createdAt: 2 }),
        makeTask({ id: "a", yunxiaoSerialNumber: "QHDK-A", planId: "p1", createdAt: 1 }),
      ],
      new Map([["p1", makePlan()]]),
      {},
    );
    expect(ordered.map((t) => t.id)).toEqual(["a", "z"]);
  });
});

describe("selectAutoStart", () => {
  const planById = new Map([["p1", makePlan()]]);

  it("前置未满足的等待任务不放行", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
        }),
      ],
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual([]);
  });

  it("前置已满足则放行", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({
          id: "ta",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "done",
        }),
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
        }),
      ],
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual(["tb"]);
  });

  it("默认串行：同项目有活跃任务时不放行（等槽位）", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({ id: "running", projectId: "proj", status: "running" }),
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "waiting_deps",
        }),
      ],
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual([]);
  });

  it("并发上限 2 时，同项目同时放行两个满足条件的等待任务", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({
          id: "ta",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "waiting_deps",
          createdAt: 1,
        }),
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
          createdAt: 2,
        }),
      ],
      // 空图：两者都无依赖 → 都可放行
      depsByPlanId: {},
      planById,
      maxConcurrentByProjectId: { proj: 2 },
      defaultMaxConcurrent: 1,
    });
    expect(startIds.sort()).toEqual(["ta", "tb"]);
  });

  it("planDepsIgnored 的任务即使前置未满足也放行（人工越过）", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
          planDepsIgnored: true,
        }),
      ],
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual(["tb"]);
  });

  it("按项目独立计算槽位，互不影响", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({ id: "runP", projectId: "p", status: "running" }),
        makeTask({
          id: "wP",
          projectId: "p",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "waiting_deps",
        }),
        makeTask({
          id: "wQ",
          projectId: "q",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "waiting_deps",
        }),
      ],
      depsByPlanId: {},
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    // p 已被 runP 占满，q 空闲 → 只放行 wQ
    expect(startIds).toEqual(["wQ"]);
  });
});

describe("「开始」一键启动：新待办一律 waiting_deps，由调度逐个放行", () => {
  const planById = new Map([["p1", makePlan()]]);

  /** 预览页「开始」的产物：A→B→C 三个议题，无前置者即可开工，其余等待。 */
  function createdWaiting(): Task[] {
    return ["QHDK-A", "QHDK-B", "QHDK-C"].map((serial, i) =>
      makeTask({
        id: `auto-${i}`,
        planId: "p1",
        yunxiaoSerialNumber: serial,
        status: "waiting_deps",
        createdAt: 100 + i,
      }),
    );
  }

  it("首轮只放行无前置的 A（同项目串行，B/C 仍等待）", () => {
    const startIds = selectAutoStart({
      tasks: createdWaiting(),
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual(["auto-0"]);
  });

  it("A 完成后接续放行 B，C 继续等待", () => {
    const tasks = createdWaiting().map((task) =>
      task.id === "auto-0" ? { ...task, status: "done" as TaskStatus } : task,
    );
    const startIds = selectAutoStart({
      tasks,
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual(["auto-1"]);
  });

  it("项目已有活跃任务时不抢跑（全部等待，等槽位）", () => {
    const startIds = selectAutoStart({
      tasks: [
        makeTask({ id: "busy", projectId: "proj", status: "running" }),
        ...createdWaiting(),
      ],
      depsByPlanId: { p1: CHAIN },
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    expect(startIds).toEqual([]);
  });

  it("依赖缺失（deps.json 未解析）时视为无依赖，仅按串行逐个放行", () => {
    const startIds = selectAutoStart({
      tasks: createdWaiting(),
      depsByPlanId: {},
      planById,
      maxConcurrentByProjectId: {},
      defaultMaxConcurrent: 1,
    });
    // 无依赖图 → A 可开工；串行上限 1 只放一个
    expect(startIds).toEqual(["auto-0"]);
  });
});

describe("hasFreeSlot（手动启动与自动接续共用的串行守卫，L1）", () => {
  it("并发上限 1：项目已有活跃任务时无空闲槽位", () => {
    expect(
      hasFreeSlot(
        [makeTask({ id: "busy", projectId: "p", status: "running" })],
        "p",
        undefined,
        1,
      ),
    ).toBe(false);
  });

  it("等待态 / 终态任务不占槽位，仍有空闲槽位", () => {
    expect(
      hasFreeSlot(
        [
          makeTask({ id: "w", projectId: "p", status: "waiting_deps" }),
          makeTask({ id: "d", projectId: "p", status: "done" }),
        ],
        "p",
        undefined,
        1,
      ),
    ).toBe(true);
  });

  it("只看本项目：别的项目在跑不影响本项目的槽位", () => {
    expect(
      hasFreeSlot([makeTask({ id: "busy", projectId: "q", status: "running" })], "p", undefined, 1),
    ).toBe(true);
  });

  it("并发上限放开到 2 时，已有 1 个活跃任务仍可启动", () => {
    const tasks = [makeTask({ id: "busy", projectId: "p", status: "running" })];
    expect(hasFreeSlot(tasks, "p", 2, 1)).toBe(true);
    expect(hasFreeSlot(tasks, "p", 1, 1)).toBe(false);
  });

  it("配置值非法（0 / 负数 / NaN）时回落默认上限", () => {
    expect(resolveMaxConcurrent(undefined, 1)).toBe(1);
    expect(resolveMaxConcurrent(0, 1)).toBe(1);
    expect(resolveMaxConcurrent(-3, 1)).toBe(1);
    expect(resolveMaxConcurrent(Number.NaN, 1)).toBe(1);
    expect(resolveMaxConcurrent(3, 1)).toBe(3);
  });
});

describe("buildWaitingBadges", () => {
  it("等待前置 → kind=deps + 计数；前置满足但无槽 → kind=slot", () => {
    const badges = buildWaitingBadges(
      [
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
        }),
        makeTask({
          id: "ta",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-A",
          status: "waiting_deps",
        }),
      ],
      { p1: CHAIN },
    );
    expect(badges.get("tb")).toEqual({ kind: "deps", count: 1, blocked: false });
    // A 无前置 → 已满足但在排队等槽位
    expect(badges.get("ta")).toEqual({ kind: "slot", count: 0, blocked: false });
  });

  it("前置缺失/异常 → blocked 标红", () => {
    const badges = buildWaitingBadges(
      [
        makeTask({
          id: "tb",
          planId: "p1",
          yunxiaoSerialNumber: "QHDK-B",
          status: "waiting_deps",
        }),
      ],
      { p1: CHAIN },
    );
    expect(badges.get("tb")).toEqual({ kind: "deps", count: 1, blocked: true });
  });

  it("非等待态任务不入表", () => {
    const badges = buildWaitingBadges(
      [makeTask({ id: "t1", status: "running" }), makeTask({ id: "t2", status: "todo" })],
      {},
    );
    expect(badges.size).toBe(0);
  });
});
