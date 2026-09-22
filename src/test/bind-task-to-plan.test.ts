import { describe, expect, it } from "vitest";
import type { DeliveryPlan, Task } from "../types";
import {
  bindTaskToDeliveryPlan,
  findDeliveryPlanForWorkitems,
} from "../components/delivery-plan/bindTaskToPlan";

const plan = (over: Partial<DeliveryPlan> = {}): DeliveryPlan => ({
  id: "dp1",
  projectId: "p1",
  name: "锁号地址挂号异常问题",
  kind: "fix",
  branch: "fix/v2/develop/锁号",
  baseBranch: "master",
  targetBranch: "develop",
  issues: [
    { workitemId: "w1", serialNumber: "QHDK-30439", subject: "ApiUrl 为空" },
    { workitemId: "w2", serialNumber: "QHDK-30502", subject: "Newtonsoft 排查" },
  ],
  status: "active",
  createdAt: 1,
  useWorktree: true,
  worktreePath: "H:/wt/dp1",
  worktreeRepo: "H:/repo",
  ...over,
});

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
  prompt: "修一下",
  agent: "claude",
  permissionMode: "ask",
  status: "pending",
  createdAt: 1,
  yunxiaoWorkitemId: "w1",
  yunxiaoSerialNumber: "QHDK-30439",
  ...over,
});

describe("findDeliveryPlanForWorkitems", () => {
  it("命中包含任一议题的活跃计划", () => {
    expect(findDeliveryPlanForWorkitems([plan()], ["w2"])?.id).toBe("dp1");
    expect(findDeliveryPlanForWorkitems([plan()], ["nope"])).toBeUndefined();
    expect(findDeliveryPlanForWorkitems([plan()], [])).toBeUndefined();
  });

  it("已收尾计划不吸附新任务", () => {
    const merged = plan({ status: "merged" });
    const closed = plan({ status: "closed" });
    expect(findDeliveryPlanForWorkitems([merged, closed], ["w1"])).toBeUndefined();
  });

  it("一议题一计划：最多命中一个", () => {
    const a = plan({ id: "a", issues: [{ workitemId: "w1", serialNumber: "Q-1", subject: "" }] });
    const b = plan({ id: "b", issues: [{ workitemId: "w1", serialNumber: "Q-1", subject: "" }] });
    expect(findDeliveryPlanForWorkitems([a, b], ["w1"])?.id).toBe("a");
  });
});

describe("bindTaskToDeliveryPlan", () => {
  it("执行任务强制绑定并带出 worktree 字段", () => {
    const bound = bindTaskToDeliveryPlan(task(), [plan()]);
    expect(bound.deliveryPlanId).toBe("dp1");
    expect(bound.worktreePath).toBe("H:/wt/dp1");
    expect(bound.worktreeBranch).toBe("fix/v2/develop/锁号");
    expect(bound.baseBranch).toBe("master");
    expect(bound.worktreeRepo).toBe("H:/repo");
  });

  it("无 worktree 计划：只记归属，worktree 留空（主检出语义）", () => {
    const bound = bindTaskToDeliveryPlan(task(), [plan({ useWorktree: false })]);
    expect(bound.deliveryPlanId).toBe("dp1");
    expect(bound.worktreePath).toBeUndefined();
    expect(bound.worktreeBranch).toBeUndefined();
  });

  it("讨论任务只记归属不进 worktree", () => {
    const bound = bindTaskToDeliveryPlan(task({ yunxiaoPlanDiscussion: true }), [plan()]);
    expect(bound.deliveryPlanId).toBe("dp1");
    expect(bound.worktreePath).toBeUndefined();
  });

  it("已绑定 / 无议题任务 / 议题不在任何计划：不动", () => {
    const boundTask = bindTaskToDeliveryPlan(task({ deliveryPlanId: "x" }), [plan()]);
    expect(boundTask.deliveryPlanId).toBe("x");
    expect(
      bindTaskToDeliveryPlan(task({ yunxiaoWorkitemId: undefined }), [plan()]).deliveryPlanId,
    ).toBeUndefined();
    expect(bindTaskToDeliveryPlan(task({ yunxiaoWorkitemId: "nope" }), [plan()]).deliveryPlanId).toBeUndefined();
  });

  it("多议题讨论任务经显式 workitemId 列表绑定", () => {
    const discussion = task({ yunxiaoWorkitemId: undefined, yunxiaoPlanDiscussion: true });
    const bound = bindTaskToDeliveryPlan(discussion, [plan()], ["w2"]);
    expect(bound.deliveryPlanId).toBe("dp1");
    expect(bound.worktreePath).toBeUndefined();
  });
});
