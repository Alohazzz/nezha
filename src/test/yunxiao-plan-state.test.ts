import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../types";
import {
  buildIssuePlanInfoMap,
  getIssuePlanInfo,
} from "../utils/yunxiaoPlanState";

function task(partial: Partial<Task> & { id: string }): Task {
  return {
    projectId: "p1",
    prompt: "",
    agent: "claude",
    permissionMode: "ask",
    status: "todo",
    createdAt: 1,
    ...partial,
  };
}

function plan(partial: Partial<Plan> & { id: string }): Plan {
  return {
    projectId: "p1",
    name: "",
    issues: [],
    status: "draft",
    createdAt: 1,
    ...partial,
  };
}

const ISSUE_ID = "wi-1";

function planWithIssue(partial: Partial<Plan> & { id: string }): Plan {
  return plan({
    ...partial,
    issues: [
      {
        workitemId: ISSUE_ID,
        serialNumber: "QHDK-1",
        subject: "议题一",
        category: "Req",
      },
    ],
  });
}

describe("getIssuePlanInfo：按议题 ID 反查方案状态", () => {
  it("无方案无任务 → none，无任何动作", () => {
    const info = getIssuePlanInfo(ISSUE_ID, [], []);
    expect(info.state).toBe("none");
    expect(info.plan).toBeNull();
    expect(info.actions.view).toBe(false);
  });

  it("讨论任务运行中 → discussing；input_required → awaiting_input（去回答）", () => {
    const plans = [planWithIssue({ id: "pl1", status: "draft" })];
    const discussion = (status: Task["status"]) => [
      task({
        id: "t1",
        planId: "pl1",
        yunxiaoPlanDiscussion: true,
        status,
      }),
    ];

    const running = getIssuePlanInfo(ISSUE_ID, discussion("running"), plans);
    expect(running.state).toBe("discussing");
    expect(running.actions.openTask).toBe(true);
    expect(running.actions.rediscuss).toBe(true);
    expect(running.actions.startPlan).toBe(false);

    const asking = getIssuePlanInfo(ISSUE_ID, discussion("input_required"), plans);
    expect(asking.state).toBe("awaiting_input");
    expect(asking.actions.openTask).toBe(true);
  });

  it("讨论任务失败/取消 → discussion_broken（继续讨论 + 删除重议）", () => {
    const plans = [planWithIssue({ id: "pl1", status: "draft" })];
    const tasks = [task({ id: "t1", planId: "pl1", yunxiaoPlanDiscussion: true, status: "failed" })];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, plans);
    expect(info.state).toBe("discussion_broken");
    expect(info.actions.resumeDiscussion).toBe(true);
    expect(info.actions.rediscuss).toBe(true);
  });

  it("已定稿（finalized）→ 执行方案 + 删除重议", () => {
    const plans = [planWithIssue({ id: "pl1", status: "finalized" })];
    const tasks = [task({ id: "t1", planId: "pl1", yunxiaoPlanDiscussion: true, status: "done" })];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, plans);
    expect(info.state).toBe("finalized");
    expect(info.actions.startPlan).toBe(true);
    expect(info.actions.rediscuss).toBe(true);
    expect(info.actions.cancelPlan).toBe(true);
  });

  it("执行中（executing）→ 继续执行 + 取消方案逃生；不可删除重议", () => {
    const plans = [planWithIssue({ id: "pl1", status: "executing" })];
    const tasks = [task({ id: "t1", planId: "pl1", yunxiaoWorkitemId: ISSUE_ID, status: "running" })];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, plans);
    expect(info.state).toBe("executing");
    expect(info.actions.continuePlan).toBe(true);
    expect(info.actions.cancelPlan).toBe(true);
    expect(info.actions.rediscuss).toBe(false);
  });

  it("已完成（completed）→ 只读查看", () => {
    const plans = [planWithIssue({ id: "pl1", status: "completed" })];
    const tasks = [task({ id: "t1", planId: "pl1", yunxiaoWorkitemId: ISSUE_ID, status: "done" })];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, plans);
    expect(info.state).toBe("completed");
    expect(info.actions.view).toBe(true);
    expect(info.actions.startPlan).toBe(false);
    expect(info.actions.rediscuss).toBe(false);
  });

  it("无方案但有任务直接绑定 → direct_task（查看任务）", () => {
    const tasks = [task({ id: "t9", yunxiaoWorkitemId: ISSUE_ID, status: "running" })];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, []);
    expect(info.state).toBe("direct_task");
    expect(info.plan).toBeNull();
    expect(info.task?.id).toBe("t9");
    expect(info.actions.locateTask).toBe(true);
    expect(info.actions.view).toBe(false);
  });

  it("cancelled 方案不占用：议题回到 none", () => {
    const cancelled = getIssuePlanInfo(
      ISSUE_ID,
      [],
      [planWithIssue({ id: "pl1", status: "cancelled" })],
    );
    expect(cancelled.state).toBe("none");
  });

  it("孤儿方案（讨论任务已删）仍要展示：定稿可执行，讨论中断可删除重议", () => {
    // 讨论任务被删后方案成孤儿，但方案记录与 plan.md 还在——议题行必须继续
    // 给出「执行方案 / 删除重议」出口，而不是回落成无方案三按钮。
    const finalized = getIssuePlanInfo(ISSUE_ID, [], [
      planWithIssue({ id: "pl1", status: "finalized" }),
    ]);
    expect(finalized.state).toBe("finalized");
    expect(finalized.actions.startPlan).toBe(true);
    expect(finalized.actions.rediscuss).toBe(true);

    const draft = getIssuePlanInfo(ISSUE_ID, [], [
      planWithIssue({ id: "pl2", status: "draft" }),
    ]);
    expect(draft.state).toBe("discussion_broken");
    expect(draft.actions.resumeDiscussion).toBe(false);
    expect(draft.actions.rediscuss).toBe(true);
    expect(draft.actions.cancelPlan).toBe(true);
  });

  it("同议题出现在多个活跃方案 → 取最近创建的一个", () => {
    const plans = [
      planWithIssue({ id: "old", status: "finalized", createdAt: 1 }),
      planWithIssue({ id: "new", status: "draft", createdAt: 2 }),
    ];
    const tasks = [
      task({ id: "t1", planId: "old", yunxiaoPlanDiscussion: true, status: "done" }),
      task({ id: "t2", planId: "new", yunxiaoPlanDiscussion: true, status: "running" }),
    ];
    const info = getIssuePlanInfo(ISSUE_ID, tasks, plans);
    expect(info.plan?.id).toBe("new");
    expect(info.state).toBe("discussing");
  });

  it("批量版与单查版一致", () => {
    const plans = [planWithIssue({ id: "pl1", status: "finalized" })];
    const tasks = [task({ id: "t1", planId: "pl1", yunxiaoPlanDiscussion: true, status: "done" })];
    const map = buildIssuePlanInfoMap([{ id: ISSUE_ID }, { id: "wi-other" }], tasks, plans);
    expect(map.get(ISSUE_ID)?.state).toBe("finalized");
    expect(map.get("wi-other")?.state).toBe("none");
  });
});
