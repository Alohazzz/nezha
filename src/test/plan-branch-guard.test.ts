import { describe, expect, it } from "vitest";
import type { DeliveryPlan } from "../types";
import {
  planBranchDrift,
  planNeedsBranchCheckout,
} from "../components/delivery-plan/planBranchGuard";

const plan = (over: Partial<DeliveryPlan> = {}): DeliveryPlan => ({
  id: "dp1",
  projectId: "p1",
  name: "处方打印问题修复",
  kind: "fix",
  branch: "fix/v2.20260901/处方打印问题修复",
  baseBranch: "master",
  targetBranch: "master",
  issues: [],
  status: "active",
  createdAt: 1,
  useWorktree: false,
  ...over,
});

describe("planNeedsBranchCheckout", () => {
  it("主检出计划需要校验", () => {
    expect(planNeedsBranchCheckout(plan())).toBe(true);
  });

  it("worktree 计划由路径钉死分支，不校验", () => {
    expect(planNeedsBranchCheckout(plan({ useWorktree: true }))).toBe(false);
  });

  it("已收尾计划不校验（分支可能已被清理）", () => {
    expect(planNeedsBranchCheckout(plan({ status: "merged" }))).toBe(false);
    expect(planNeedsBranchCheckout(plan({ status: "closed" }))).toBe(false);
  });

  it("缺计划 / 空分支名不校验", () => {
    expect(planNeedsBranchCheckout(undefined)).toBe(false);
    expect(planNeedsBranchCheckout(plan({ branch: "  " }))).toBe(false);
  });
});

describe("planBranchDrift", () => {
  it("当前分支就是计划分支：放行", () => {
    expect(planBranchDrift(plan(), "fix/v2.20260901/处方打印问题修复")).toBeNull();
  });

  it("事故实况：计划分支被改名 → 报漂移", () => {
    const drift = planBranchDrift(plan(), "fix/v2.20260901/QHDK-30486-处方打印医保类别勾选报错");
    expect(drift).toEqual({
      currentBranch: "fix/v2.20260901/QHDK-30486-处方打印医保类别勾选报错",
      expectedBranch: "fix/v2.20260901/处方打印问题修复",
    });
  });

  it("游离 HEAD（空串）也算漂移", () => {
    expect(planBranchDrift(plan(), "")?.currentBranch).toBe("");
  });

  it("比对前 trim（rev-parse 输出常带空白）", () => {
    expect(planBranchDrift(plan(), "  fix/v2.20260901/处方打印问题修复\n")).toBeNull();
  });

  it("worktree 计划永不放行阻断（路径已钉死分支）", () => {
    expect(planBranchDrift(plan({ useWorktree: true }), "master")).toBeNull();
  });
});
