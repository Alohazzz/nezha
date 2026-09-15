import { describe, expect, it } from "vitest";
import {
  buildPlanExecutionPrompt,
  buildUpstreamPlanContext,
  extractPlanOverviewForIssues,
  planAncestorSerials,
  planAncestorChain,
} from "../utils/plan";
import { buildTaskBySerial } from "../utils/planQueue";
import type { Plan, Task } from "../types";

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

/** 方案树测试数据：root ← mid ← leaf，另有独立方案 solo。 */
function makePlan(id: string, parentPlanId?: string, serials: string[] = []): Plan {
  return {
    id,
    projectId: "p1",
    name: id,
    issues: serials.map((serialNumber) => ({
      workitemId: `wi-${serialNumber}`,
      serialNumber,
      subject: `议题 ${serialNumber}`,
    })),
    status: "executing",
    parentPlanId,
    createdAt: 1,
  };
}

describe("planAncestorChain", () => {
  it("返回从直接父级到根的顺序", () => {
    const plans = [
      makePlan("root"),
      makePlan("mid", "root"),
      makePlan("leaf", "mid"),
      makePlan("solo"),
    ];
    expect(planAncestorChain("leaf", plans).map((p) => p.id)).toEqual(["mid", "root"]);
    expect(planAncestorChain("mid", plans).map((p) => p.id)).toEqual(["root"]);
  });

  it("根方案与不存在的方案都返回空链", () => {
    const plans = [makePlan("root"), makePlan("mid", "root")];
    expect(planAncestorChain("root", plans)).toEqual([]);
    expect(planAncestorChain("ghost", plans)).toEqual([]);
  });

  it("父方案已删除时停在断点，不含断链以上的祖先", () => {
    const plans = [makePlan("root"), makePlan("leaf", "mid")];
    expect(planAncestorChain("leaf", plans)).toEqual([]);
  });

  it("parentPlanId 成环时靠 visited 收敛，不丢已解析出的祖先也不死循环", () => {
    const plans = [makePlan("a", "b"), makePlan("b", "a")];
    expect(planAncestorChain("a", plans).map((p) => p.id)).toEqual(["b"]);
    expect(planAncestorChain("b", plans).map((p) => p.id)).toEqual(["a"]);
  });

  it("self-parent 立即收敛", () => {
    const plans = [makePlan("a", "a")];
    expect(planAncestorChain("a", plans)).toEqual([]);
  });
});

describe("planAncestorSerials", () => {
  it("合集覆盖整条祖先链的议题编号（父 + 祖父）", () => {
    const plans = [
      makePlan("root", undefined, ["QHDK-R1", "QHDK-R2"]),
      makePlan("mid", "root", ["QHDK-M1"]),
      makePlan("leaf", "mid", ["QHDK-L1"]),
    ];
    expect(planAncestorSerials("leaf", plans)).toEqual(["QHDK-M1", "QHDK-R1", "QHDK-R2"]);
  });

  it("根方案无祖先 → 空数组（等价于不放开任何外部引用）", () => {
    const plans = [makePlan("root", undefined, ["QHDK-R1"])];
    expect(planAncestorSerials("root", plans)).toEqual([]);
  });
});

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

describe("buildUpstreamPlanContext（追加子方案的讨论上下文）", () => {
  const parent = makePlan("main", undefined, ["QHDK-P1", "QHDK-P2"]);

  it("无祖先时不产出任何内容（独立方案的 prompt 不受影响）", () => {
    expect(
      buildUpstreamPlanContext({
        ancestors: [],
        planMdPathById: {},
        taskBySerial: new Map(),
      }),
    ).toBe("");
  });

  it("内联议题清单 + 方案文档绝对路径，并声明可引用范围", () => {
    const context = buildUpstreamPlanContext({
      ancestors: [parent],
      planMdPathById: { main: "H:/proj/.nezha/plans/main/plan.md" },
      taskBySerial: new Map(),
    });
    expect(context).toContain("## 上游方案（追加来源）");
    expect(context).toContain("QHDK-P1");
    expect(context).toContain("议题 QHDK-P1");
    expect(context).toContain("H:/proj/.nezha/plans/main/plan.md");
    expect(context).toContain("没有依赖就不要写");
  });

  it("议题状态来自全局任务：无任务标「未生成待办」，异常状态如实标注", () => {
    const taskBySerial = buildTaskBySerial([
      makeTask("QHDK-P1", "done"),
      makeTask("QHDK-P2", "failed"),
    ]);
    const context = buildUpstreamPlanContext({
      ancestors: [parent],
      planMdPathById: {},
      taskBySerial,
    });
    expect(context).toContain("QHDK-P1 议题 QHDK-P1（已完成）");
    expect(context).toContain("QHDK-P2 议题 QHDK-P2（已失败）");
  });

  it("多级追加：祖父方案也列出（决策 D-b 允许引用整条祖先链）", () => {
    const grand = makePlan("root", undefined, ["QHDK-G1"]);
    const context = buildUpstreamPlanContext({
      ancestors: [parent, grand],
      planMdPathById: {
        main: "H:/p/.nezha/plans/main/plan.md",
        root: "H:/p/.nezha/plans/root/plan.md",
      },
      taskBySerial: new Map(),
    });
    expect(context).toContain("QHDK-P1");
    expect(context).toContain("QHDK-G1");
    expect(context).toContain("H:/p/.nezha/plans/root/plan.md");
  });
});

describe("buildPlanExecutionPrompt — 上游方案路径", () => {
  const base = {
    issue: { serialNumber: "QHDK-B1", subject: "追加议题" },
    link: "",
    planOverview: "统筹",
    issueSection: "## QHDK-B1 追加议题",
    planMdAbsolutePath: "H:/p/.nezha/plans/child/plan.md",
    imagePaths: [],
    instructions: "",
  };

  it("缺省不带「上游方案全文」节（根方案 prompt 逐字节不变）", () => {
    expect(buildPlanExecutionPrompt(base)).not.toContain("上游方案全文");
  });

  it("带 upstreamPlanMdAbsolutePath 时附路径，且仍强调只执行本议题", () => {
    const prompt = buildPlanExecutionPrompt({
      ...base,
      upstreamPlanMdAbsolutePath: "H:/p/.nezha/plans/main/plan.md",
    });
    expect(prompt).toContain("## 上游方案全文");
    expect(prompt).toContain("H:/p/.nezha/plans/main/plan.md");
    expect(prompt).toContain("不要执行上游方案的改动");
  });

  it("空字符串不加节（调用方传 undefined/空串同义）", () => {
    expect(buildPlanExecutionPrompt({ ...base, upstreamPlanMdAbsolutePath: "  " })).not.toContain(
      "上游方案全文",
    );
  });
});
