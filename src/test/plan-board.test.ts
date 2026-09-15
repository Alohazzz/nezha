import { describe, expect, it } from "vitest";
import type { Plan, PlanStatus, Task, TaskStatus } from "../types";
import { parsePlanDeps } from "../utils/planDeps";
import {
  buildTaskBySerial,
  derivePlanTaskRows,
  groupPlansByProject,
  isPlanArchived,
  planLifecycleActions,
  satisfiedDependencies,
  tasksForPlan,
} from "../utils/planBoard";

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "p1",
    projectId: "proj",
    name: "方案",
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
    projectId: "proj",
    prompt: "p",
    agent: "claude",
    permissionMode: "ask",
    status: "todo" as TaskStatus,
    createdAt: 1,
    ...overrides,
  };
}

/** A → B（B 依赖 A）的契约示例。 */
const DEPS = parsePlanDeps(
  JSON.stringify({
    version: 1,
    issues: [
      { serialNumber: "QHDK-A", dependsOn: [] },
      { serialNumber: "QHDK-B", dependsOn: ["QHDK-A"] },
    ],
    executionOrder: ["QHDK-A", "QHDK-B"],
  }),
  ["QHDK-A", "QHDK-B"],
);

describe("isPlanArchived", () => {
  it("archivedAt 为数字即归档（0 也算，不是 falsy 判断）", () => {
    expect(isPlanArchived({})).toBe(false);
    expect(isPlanArchived({ archivedAt: 0 })).toBe(true);
    expect(isPlanArchived({ archivedAt: 123 })).toBe(true);
  });
});

describe("planLifecycleActions", () => {
  it("只有执行中可标记完成；已完成可重开", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canComplete).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canComplete).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canReopen).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "executing" })).canReopen).toBe(false);
  });

  it("讨论中 / 已定稿都不能标记完成——尚未开展或尚未生成待办", () => {
    expect(planLifecycleActions(makePlan({ status: "draft" })).canComplete).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "finalized" })).canComplete).toBe(false);
  });

  it("取消是留存态：非 cancelled 均可取消，已取消不可再取消", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canCancel).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "cancelled" })).canCancel).toBe(false);
  });

  it("归档只在已完成时可用；归档后可反归档，且完成/重开/取消均不可用", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canArchive).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canArchive).toBe(true);
    const archived = planLifecycleActions(makePlan({ status: "executing", archivedAt: 9 }));
    expect(archived.canUnarchive).toBe(true);
    expect(archived.canComplete).toBe(false);
    expect(archived.canCancel).toBe(false);
    expect(archived.canReopen).toBe(false);
  });

  it("删除在任何状态下都允许（危险操作，确认交给 UI）", () => {
    for (const status of ["draft", "finalized", "executing", "completed", "cancelled"] as const) {
      expect(planLifecycleActions(makePlan({ status })).canDelete).toBe(true);
    }
  });
});

describe("tasksForPlan / buildTaskBySerial", () => {
  it("只收本方案任务，忽略其他方案与无编号任务", () => {
    const tasks = [
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A" }),
      makeTask({ id: "t2", planId: "p2", yunxiaoSerialNumber: "QHDK-B" }),
      makeTask({ id: "t3", planId: "p1" }),
    ];
    const map = tasksForPlan({ id: "p1" }, tasks);
    expect([...map.keys()]).toEqual(["QHDK-A"]);
  });

  it("全局索引跨方案可查到（跨祖先方案引用的前置条件）", () => {
    const map = buildTaskBySerial([
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A" }),
      makeTask({ id: "t2", planId: "p2", yunxiaoSerialNumber: "QHDK-X" }),
    ]);
    expect(map.get("QHDK-X")?.id).toBe("t2");
  });
});

describe("derivePlanTaskRows — 任务行为主体", () => {
  it("每个议题一行，未生成待办的议题 task 为 null", () => {
    const rows = derivePlanTaskRows(makePlan(), [
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
    ]);
    expect(rows.rows).toHaveLength(2);
    const a = rows.rows.find((r) => r.serialNumber === "QHDK-A");
    const b = rows.rows.find((r) => r.serialNumber === "QHDK-B");
    expect(a?.task?.id).toBe("t1");
    expect(a?.status).toBe("done");
    expect(b?.task).toBeNull();
    expect(b?.status).toBeNull();
    expect(rows.done).toBe(1);
    expect(rows.allDone).toBe(false);
  });

  it("按拓扑序排列行（前置在前），与接续顺序一致", () => {
    const rows = derivePlanTaskRows(makePlan(), [], DEPS);
    expect(rows.rows.map((r) => r.serialNumber)).toEqual(["QHDK-A", "QHDK-B"]);
  });

  it("无 deps 时按 plan.issues 给定顺序", () => {
    const plan = makePlan({
      issues: [
        { workitemId: "w2", serialNumber: "QHDK-B", subject: "B" },
        { workitemId: "w1", serialNumber: "QHDK-A", subject: "A" },
      ],
    });
    const rows = derivePlanTaskRows(plan, []);
    expect(rows.rows.map((r) => r.serialNumber)).toEqual(["QHDK-B", "QHDK-A"]);
  });

  it("failed / cancelled / interrupted 不算完成，只有 done 算", () => {
    const plan = makePlan({ issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "A" }] });
    for (const status of ["failed", "cancelled", "interrupted", "running", "todo"] as const) {
      const rows = derivePlanTaskRows(plan, [
        makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status }),
      ]);
      expect(rows.done).toBe(0);
      expect(rows.allDone).toBe(false);
    }
  });

  it("无议题的方案 allDone 为 false（避免空方案被当成已完成）", () => {
    expect(derivePlanTaskRows(makePlan({ issues: [] }), []).allDone).toBe(false);
  });

  it("统计 runningCount（在跑的议题数，占并发槽）", () => {
    const rows = derivePlanTaskRows(makePlan(), [
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "running" }),
      makeTask({ id: "t2", planId: "p1", yunxiaoSerialNumber: "QHDK-B", status: "todo" }),
    ]);
    expect(rows.runningCount).toBe(1);
  });

  it("行内携带 statusSince（updatedAt 优先，回落 createdAt）", () => {
    const rows = derivePlanTaskRows(makePlan(), [
      makeTask({
        planId: "p1",
        yunxiaoSerialNumber: "QHDK-A",
        createdAt: 100,
        updatedAt: 200,
      }),
    ]);
    expect(rows.rows.find((r) => r.serialNumber === "QHDK-A")?.statusSince).toBe(200);
  });
});

describe("derivePlanTaskRows — 前置约束", () => {
  it("前置未 done → unmet；前置 done → 无约束", () => {
    const plan = makePlan();
    const blocked = derivePlanTaskRows(plan, [], DEPS);
    const b = blocked.rows.find((r) => r.serialNumber === "QHDK-B");
    expect(b?.dependsOn).toEqual(["QHDK-A"]);
    expect(b?.unmet).toEqual(["QHDK-A"]);
    // A 根本没有任务 → 属「缺失」，需人工越过（不是普通 pending）
    expect(b?.needsOverride).toBe(true);
    expect(blocked.unmetEdges).toBe(1);

    const ok = derivePlanTaskRows(
      plan,
      [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" })],
      DEPS,
    );
    expect(ok.rows.find((r) => r.serialNumber === "QHDK-B")?.unmet).toEqual([]);
    expect(ok.unmetEdges).toBe(0);
  });

  it("前置有任务但未 done → unmet 但 needsOverride 为 false（普通等待）", () => {
    const rows = derivePlanTaskRows(
      makePlan(),
      [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "running" })],
      DEPS,
    );
    const b = rows.rows.find((r) => r.serialNumber === "QHDK-B");
    expect(b?.unmet).toEqual(["QHDK-A"]);
    expect(b?.needsOverride).toBe(false);
  });

  it("前置任务缺失 → needsOverride（不静默放行）", () => {
    const b = derivePlanTaskRows(makePlan(), [], DEPS).rows.find(
      (r) => r.serialNumber === "QHDK-B",
    );
    expect(b?.unmet).toEqual(["QHDK-A"]);
    expect(b?.needsOverride).toBe(true);
  });

  it("前置异常（failed）→ needsOverride", () => {
    const rows = derivePlanTaskRows(
      makePlan(),
      [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "failed" })],
      DEPS,
    );
    expect(rows.rows.find((r) => r.serialNumber === "QHDK-B")?.needsOverride).toBe(true);
  });

  it("依赖解析走全局任务表：前置任务属另一方案时同样能判定", () => {
    const rows = derivePlanTaskRows(
      makePlan({ id: "p2" }),
      [makeTask({ id: "tA", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" })],
      DEPS,
    );
    expect(rows.rows.find((r) => r.serialNumber === "QHDK-B")?.unmet).toEqual([]);
  });

  it("satisfiedDependencies 只列已满足且存在的编号", () => {
    const doneTask = makeTask({
      planId: "p1",
      yunxiaoSerialNumber: "QHDK-A",
      status: "done",
    });
    const rows = derivePlanTaskRows(makePlan(), [doneTask], DEPS);
    const b = rows.rows.find((r) => r.serialNumber === "QHDK-B");
    expect(b).toBeDefined();
    expect(satisfiedDependencies(b!, [doneTask])).toEqual(["QHDK-A"]);
  });
});

describe("groupPlansByProject", () => {
  it("按项目分组；归档进 archived、不计入活跃方案", () => {
    const groups = groupPlansByProject(
      [
        makePlan({ id: "a", projectId: "p", status: "executing" }),
        makePlan({ id: "b", projectId: "p", status: "completed", archivedAt: 10 }),
      ],
      new Set(),
    );
    const p = groups.find((g) => g.projectId === "p");
    expect(p?.plans.map((x) => x.id)).toEqual(["a"]);
    expect(p?.archived.map((x) => x.id)).toEqual(["b"]);
    expect(p?.activePlanCount).toBe(1);
  });

  it("已完成的方案不计入活跃；有任务在跑的方案计入", () => {
    const groups = groupPlansByProject(
      [
        makePlan({ id: "done", projectId: "p", status: "completed" }),
        makePlan({ id: "running", projectId: "p", status: "completed" }),
      ],
      new Set(["running"]),
    );
    expect(groups[0].activePlanCount).toBe(1);
  });

  it("组内：有任务在动的方案优先，其余按 createdAt 升序", () => {
    const groups = groupPlansByProject(
      [
        makePlan({ id: "calm", projectId: "p", status: "draft", createdAt: 1 }),
        makePlan({ id: "busy", projectId: "p", status: "executing", createdAt: 9 }),
      ],
      new Set(["busy"]),
    );
    expect(groups[0].plans.map((x) => x.id)).toEqual(["busy", "calm"]);
  });

  it("项目按活跃数倒序、其次 projectId（结果确定）", () => {
    const groups = groupPlansByProject(
      [
        makePlan({ id: "a", projectId: "beta", status: "executing", createdAt: 5 }),
        makePlan({ id: "b", projectId: "alpha", status: "executing", createdAt: 3 }),
        makePlan({ id: "c", projectId: "alpha", status: "draft", createdAt: 1 }),
      ],
      new Set(),
    );
    expect(groups.map((g) => g.projectId)).toEqual(["alpha", "beta"]);
    expect(groups[0].plans.map((x) => x.id)).toEqual(["c", "b"]);
  });

  it("归档列表按归档时间倒序", () => {
    const groups = groupPlansByProject(
      [
        makePlan({ id: "old", projectId: "p", archivedAt: 1 }),
        makePlan({ id: "new", projectId: "p", archivedAt: 9 }),
      ],
      new Set(),
    );
    expect(groups[0].archived.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("空列表返回空数组", () => {
    expect(groupPlansByProject([], new Set())).toEqual([]);
  });
});

describe("PlanStatus 覆盖", () => {
  it("五种状态都能派生任务行且不崩", () => {
    const statuses: PlanStatus[] = ["draft", "finalized", "executing", "completed", "cancelled"];
    for (const status of statuses) {
      const plan = makePlan({ status });
      expect(derivePlanTaskRows(plan, []).rows).toHaveLength(2);
      expect(planLifecycleActions(plan).canDelete).toBe(true);
    }
  });
});
