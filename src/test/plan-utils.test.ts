import { describe, expect, it } from "vitest";
import {
  buildPlanExecutionPrompt,
  extractPlanOverviewForIssues,
} from "../utils/plan";

/** 单议题、无统筹节、议题节完整——讨论模型省略仪式性统筹节时的典型产物（截图场景）。 */
const SINGLE_ISSUE_MD_WITHOUT_OVERVIEW = [
  "# 方案：QHDK-30132 分段结算医保开始时间治理",
  "",
  "## QHDK-30132 分段结算同一登记流水号的医保开始时间治理",
  "### 修改方案汇总（开发向）",
  "总结：修改方案为按登记流水号取最早入院时间。",
  "### 性能影响分析",
  "无性能影响，理由：仅改查询条件。",
  "### 影响范围与测试（测试向）",
  "影响 Nto.His.Settle；回归分段结算入院时间取值。",
].join("\n");

const MULTI_ISSUE_MD_WITHOUT_OVERVIEW = [
  "# 联合方案：互斥医嘱删除",
  "",
  "## QHDK-26453 当日互斥停止医嘱",
  "### 修改方案汇总（开发向）",
  "方案 A。",
  "",
  "## QHDK-27486 互斥医嘱范围",
  "### 修改方案汇总（开发向）",
  "方案 B。",
].join("\n");

const MULTI_ISSUE_MD_WITH_OVERVIEW = [
  "# 联合方案：互斥医嘱删除",
  "",
  "## 统筹",
  "QHDK-26453 先行，公共改动由其承载提交。",
  "",
  "## QHDK-26453 当日互斥停止医嘱",
  "### 修改方案汇总（开发向）",
  "方案 A。",
].join("\n");

describe("extractPlanOverviewForIssues", () => {
  it("单议题缺统筹节不阻断（overview 为空，missing 为 false）", () => {
    const result = extractPlanOverviewForIssues(SINGLE_ISSUE_MD_WITHOUT_OVERVIEW, 1);
    expect(result.missing).toBe(false);
    expect(result.overview).toBe("");
  });

  it("多议题缺统筹节仍阻断", () => {
    const result = extractPlanOverviewForIssues(MULTI_ISSUE_MD_WITHOUT_OVERVIEW, 2);
    expect(result.missing).toBe(true);
    expect(result.overview).toBe("");
  });

  it("多议题含统筹节时正常提取", () => {
    const result = extractPlanOverviewForIssues(MULTI_ISSUE_MD_WITH_OVERVIEW, 2);
    expect(result.missing).toBe(false);
    expect(result.overview).toContain("QHDK-26453 先行");
  });

  it("单议题含统筹节时照常提取", () => {
    const result = extractPlanOverviewForIssues(MULTI_ISSUE_MD_WITH_OVERVIEW, 1);
    expect(result.missing).toBe(false);
    expect(result.overview).toContain("统筹");
  });
});

describe("buildPlanExecutionPrompt 与空 overview 的配合", () => {
  it("overview 为空时不拼「方案统筹」节（单议题放宽路径的下游契约）", () => {
    const prompt = buildPlanExecutionPrompt({
      issue: { serialNumber: "QHDK-30132", subject: "分段结算医保开始时间" },
      link: "",
      planOverview: "",
      issueSection: "## QHDK-30132 分段结算\n### 修改方案汇总（开发向）\n内容",
      planMdAbsolutePath: "H:/p/.nezha/plans/1/plan.md",
      imagePaths: [],
      instructions: "",
    });
    expect(prompt).not.toContain("方案统筹");
    expect(prompt).toContain("## 本议题方案（已定稿）");
  });
});
