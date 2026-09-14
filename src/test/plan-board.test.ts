import { describe, expect, it } from "vitest";
import type { Plan, PlanStatus, Task, TaskStatus } from "../types";
import { parsePlanDeps } from "../utils/planDeps";
import {
  buildTaskBySerial,
  derivePlanProgress,
  groupPlansForBoard,
  isPlanArchived,
  planBoardColumn,
  planLifecycleActions,
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

describe("planBoardColumn / isPlanArchived", () => {
  it("按 status 映射到对应列", () => {
    const cases: Array<[PlanStatus, string]> = [
      ["draft", "draft"],
      ["finalized", "finalized"],
      ["executing", "executing"],
      ["completed", "completed"],
      ["cancelled", "cancelled"],
    ];
    for (const [status, column] of cases) {
      expect(planBoardColumn(makePlan({ status }))).toBe(column);
    }
  });

  it("已归档的方案不落任何主列（AR1）", () => {
    const plan = makePlan({ status: "completed", archivedAt: 123 });
    expect(isPlanArchived(plan)).toBe(true);
    expect(planBoardColumn(plan)).toBeNull();
  });

  it("archivedAt 为 0 也算归档（不是 falsy 判断）", () => {
    const plan = makePlan({ archivedAt: 0 });
    expect(isPlanArchived(plan)).toBe(true);
    expect(planBoardColumn(plan)).toBeNull();
  });
});

describe("planLifecycleActions", () => {
  it("只有执行中可标记完成；已完成可重开", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canComplete).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canComplete).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canReopen).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "executing" })).canReopen).toBe(false);
  });

  it("讨论中 / 已定稿都不能标记完成——尚未开展或尚未生成待办，收尾应走取消", () => {
    expect(planLifecycleActions(makePlan({ status: "draft" })).canComplete).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "finalized" })).canComplete).toBe(false);
  });

  it("取消是留存态：非 cancelled 均可取消，已取消不可再取消", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canCancel).toBe(true);
    expect(planLifecycleActions(makePlan({ status: "cancelled" })).canCancel).toBe(false);
  });

  it("归档只在已完成时可用；归档后可反归档", () => {
    expect(planLifecycleActions(makePlan({ status: "executing" })).canArchive).toBe(false);
    expect(planLifecycleActions(makePlan({ status: "completed" })).canArchive).toBe(true);
    const archived = planLifecycleActions(makePlan({ status: "completed", archivedAt: 9 }));
    expect(archived.canArchive).toBe(false);
    expect(archived.canUnarchive).toBe(true);
  });

  it("已归档方案的完成 / 重开 / 取消均不可用（先反归档）", () => {
    const archived = planLifecycleActions(makePlan({ status: "executing", archivedAt: 9 }));
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
    expect(map.get("QHDK-A")?.id).toBe("t1");
  });

  it("全局索引跨方案可查到（阶段三祖先引用的前置条件）", () => {
    const map = buildTaskBySerial([
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A" }),
      makeTask({ id: "t2", planId: "p2", yunxiaoSerialNumber: "QHDK-X" }),
    ]);
    expect(map.get("QHDK-X")?.id).toBe("t2");
  });
});

describe("derivePlanProgress — 进度", () => {
  it("按议题统计 done 数；未生成待办的议题算未完成", () => {
    const plan = makePlan();
    const tasks = [
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
    ];
    const progress = derivePlanProgress(plan, tasks);
    expect(progress.total).toBe(2);
    expect(progress.done).toBe(1);
    expect(progress.allDone).toBe(false);
    expect(progress.issues.map((i) => i.done)).toEqual([true, false]);
    expect(progress.issues[1].taskId).toBeNull();
    expect(progress.issues[1].status).toBeNull();
    expect(progress.noTasks).toBe(false);
  });

  it("全部议题 done → allDone；没有任何任务 → noTasks", () => {
    const plan = makePlan();
    const allDone = derivePlanProgress(plan, [
      makeTask({ id: "t1", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
      makeTask({ id: "t2", planId: "p1", yunxiaoSerialNumber: "QHDK-B", status: "done" }),
    ]);
    expect(allDone.allDone).toBe(true);
    expect(allDone.done).toBe(2);

    expect(derivePlanProgress(plan, []).noTasks).toBe(true);
  });

  it("failed / cancelled 不算完成（仅 done 算）", () => {
    const plan = makePlan({ issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "A" }] });
    for (const status of ["failed", "cancelled", "interrupted", "running", "todo"] as const) {
      const progress = derivePlanProgress(
        plan,
        [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status })],
      );
      expect(progress.done).toBe(0);
      expect(progress.allDone).toBe(false);
    }
  });

  it("无议题的方案 allDone 为 false（避免空方案被当成已完成）", () => {
    expect(derivePlanProgress(makePlan({ issues: [] }), []).allDone).toBe(false);
  });
});

describe("derivePlanProgress — 依赖摘要", () => {
  const deps = parsePlanDeps(
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

  it("无 deps 时视为无依赖，只算进度", () => {
    const progress = derivePlanProgress(makePlan(), [], undefined);
    expect(progress.unmetEdges).toBe(0);
    expect(progress.blockedIssues).toBe(0);
    expect(progress.issues[1].dependsOn).toEqual([]);
  });

  it("前置未 done → 计入 unmet；前置 done → 不计", () => {
    const plan = makePlan();
    const notDone = derivePlanProgress(plan, [], deps);
    expect(notDone.issues[1].dependsOn).toEqual(["QHDK-A"]);
    expect(notDone.issues[1].unmet).toEqual(["QHDK-A"]);
    expect(notDone.unmetEdges).toBe(1);
    expect(notDone.blockedIssues).toBe(1);

    const satisfied = derivePlanProgress(
      plan,
      [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" })],
      deps,
    );
    expect(satisfied.issues[1].unmet).toEqual([]);
    expect(satisfied.unmetEdges).toBe(0);
    expect(satisfied.blockedIssues).toBe(0);
  });

  it("前置任务缺失（未生成待办）计为 unmet，不静默放行", () => {
    const progress = derivePlanProgress(makePlan(), [], deps);
    expect(progress.issues[1].unmet).toEqual(["QHDK-A"]);
  });

  it("依赖解析走全局任务表：前置任务属另一方案时同样能判定", () => {
    const plan = makePlan({ id: "p2" });
    const tasks = [
      // 前置 QHDK-A 的任务挂在别的方案上（阶段三的跨方案依赖形态）
      makeTask({ id: "tA", planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "done" }),
    ];
    const progress = derivePlanProgress(plan, tasks, deps);
    expect(progress.issues[1].unmet).toEqual([]);
  });

  it("前置异常（failed）仍算 unmet", () => {
    const plan = makePlan();
    const progress = derivePlanProgress(
      plan,
      [makeTask({ planId: "p1", yunxiaoSerialNumber: "QHDK-A", status: "failed" })],
      deps,
    );
    expect(progress.issues[1].unmet).toEqual(["QHDK-A"]);
  });
});

describe("groupPlansForBoard", () => {
  it("按项目分组、按生命周期入列，列内按 createdAt 升序", () => {
    const groups = groupPlansForBoard([
      makePlan({ id: "a", projectId: "p", status: "executing", createdAt: 3 }),
      makePlan({ id: "b", projectId: "p", status: "executing", createdAt: 1 }),
      makePlan({ id: "c", projectId: "p", status: "draft", createdAt: 2 }),
      makePlan({ id: "d", projectId: "q", status: "completed", createdAt: 1 }),
    ]);
    const p = groups.find((g) => g.projectId === "p");
    expect(p?.columns.executing.map((x) => x.id)).toEqual(["b", "a"]);
    expect(p?.columns.draft.map((x) => x.id)).toEqual(["c"]);
    expect(p?.activeCount).toBe(3);
    expect(p?.totalCount).toBe(3);
    const q = groups.find((g) => g.projectId === "q");
    expect(q?.columns.completed.map((x) => x.id)).toEqual(["d"]);
  });

  it("归档方案进 archived、不计入任何主列与 activeCount", () => {
    const groups = groupPlansForBoard([
      makePlan({ id: "a", projectId: "p", status: "completed" }),
      makePlan({ id: "b", projectId: "p", status: "completed", archivedAt: 10 }),
    ]);
    const p = groups[0];
    expect(p.columns.completed.map((x) => x.id)).toEqual(["a"]);
    expect(p.archived.map((x) => x.id)).toEqual(["b"]);
    expect(p.activeCount).toBe(1);
    expect(p.totalCount).toBe(2);
  });

  it("归档列表按归档时间倒序", () => {
    const groups = groupPlansForBoard([
      makePlan({ id: "old", projectId: "p", archivedAt: 1 }),
      makePlan({ id: "new", projectId: "p", archivedAt: 9 }),
    ]);
    expect(groups[0].archived.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("项目顺序：主列方案数倒序，其次 projectId（结果确定）", () => {
    const groups = groupPlansForBoard([
      makePlan({ id: "a", projectId: "beta", status: "draft" }),
      makePlan({ id: "b", projectId: "alpha", status: "draft" }),
      makePlan({ id: "c", projectId: "alpha", status: "executing" }),
    ]);
    expect(groups.map((g) => g.projectId)).toEqual(["alpha", "beta"]);
  });

  it("空方案列表返回空数组", () => {
    expect(groupPlansForBoard([])).toEqual([]);
  });
});
