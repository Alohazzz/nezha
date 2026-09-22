import { describe, expect, it } from "vitest";
import type { DeliveryPlan, Plan, Task } from "../types";
import {
  deriveIssueStatus,
  type IssueStatus,
} from "../components/delivery-plan/deriveIssueStatus";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  projectId: "p1",
  prompt: "p",
  agent: "claude",
  permissionMode: "ask",
  status: "todo",
  createdAt: 1,
  yunxiaoWorkitemId: "w1",
  ...over,
});

const scheme = (over: Partial<Plan> = {}): Plan => ({
  id: "s1",
  projectId: "p1",
  name: "方案A",
  issues: [{ workitemId: "w1", serialNumber: "Q-1", subject: "" }],
  status: "draft",
  createdAt: 1,
  ...over,
});

describe("deriveIssueStatus", () => {
  it("无任务无方案＝未开始", () => {
    expect(deriveIssueStatus("w1", [], [])).toBe("not_started");
  });

  it("讨论任务非终态＝讨论中", () => {
    const t = task({ yunxiaoPlanDiscussion: true, status: "running" });
    expect(deriveIssueStatus("w1", [t], [])).toBe("discussing");
    const draft = scheme();
    expect(deriveIssueStatus("w1", [], [draft])).toBe("discussing");
  });

  it("方案已定稿/执行中/已完成＝讨论完成（无执行任务时）", () => {
    for (const status of ["finalized", "executing", "completed"] as const) {
      expect(deriveIssueStatus("w1", [], [scheme({ status })])).toBe("discussed");
    }
  });

  it("方案 cancelled 不计讨论完成", () => {
    expect(deriveIssueStatus("w1", [], [scheme({ status: "cancelled" })])).toBe("not_started");
  });

  it("执行任务非终态＝执行中（含 interrupted/detached/waiting_deps）", () => {
    for (const status of ["pending", "running", "input_required", "waiting_deps", "interrupted", "detached"] as const) {
      expect(deriveIssueStatus("w1", [task({ status })], [])).toBe("executing");
    }
  });

  it("执行任务 done＝已完成（覆盖讨论态）", () => {
    const done = task({ status: "done" });
    const running = task({ id: "t2", yunxiaoPlanDiscussion: true, status: "running" });
    expect(deriveIssueStatus("w1", [done, running], [])).toBe("done");
  });

  it("执行任务 failed/cancelled 且无在跑＝aborted", () => {
    expect(deriveIssueStatus("w1", [task({ status: "failed" })], [])).toBe("aborted");
    expect(deriveIssueStatus("w1", [task({ status: "cancelled" })], [])).toBe("aborted");
    // 有在跑的执行任务时不判 aborted（从后往前取第一个命中：执行中优先）。
    expect(
      deriveIssueStatus("w1", [task({ status: "failed" }), task({ id: "t2", status: "running" })], []),
    ).toBe("executing");
  });

  it("讨论任务 done 而方案未定稿：回落讨论中", () => {
    const t = task({ yunxiaoPlanDiscussion: true, status: "done" });
    expect(deriveIssueStatus("w1", [t], [scheme()])).toBe("discussing");
    // 无方案时讨论完成视为无信号，回到未开始。
    expect(deriveIssueStatus("w1", [t], [])).toBe("not_started");
  });

  it("多方案含同一议题全部可关联（cancelled 也展示）", () => {
    const a = scheme({ id: "a", status: "finalized" });
    const b = scheme({ id: "b", status: "cancelled" });
    expect(deriveIssueStatus("w1", [], [a, b])).toBe("discussed");
  });
});

// 类型仅导出校验
const _statuses: IssueStatus[] = ["not_started", "discussing", "discussed", "executing", "done", "aborted"];
void _statuses;
const _dp: DeliveryPlan | undefined = undefined;
void _dp;
