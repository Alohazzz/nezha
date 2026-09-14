import { describe, expect, it } from "vitest";
import {
  parsePlanDeps,
  topoSortPlanIssues,
  unmetDependencies,
  type PlanDeps,
  type PlanDepsWarningKind,
} from "../utils/planDeps";
import { planDepsPath, planMdPath } from "../utils/plan";

const kinds = (deps: PlanDeps): PlanDepsWarningKind[] => deps.warnings.map((w) => w.kind);

/**
 * 契约锁定：内容逐字取自 SkillHub `yunxiao-plan-discussion`「方案依赖文件」节的示例。
 * 技能文档改动导致本契约漂移时，这条测试应当失败（或同步更新）。
 */
const SKILL_DOC_EXAMPLE = `{
  "version": 1,
  "issues": [
    { "serialNumber": "QHDK-29749", "dependsOn": [] },
    { "serialNumber": "QHDK-29750", "dependsOn": ["QHDK-29749"] }
  ],
  "executionOrder": ["QHDK-29749", "QHDK-29750"]
}`;

describe("契约锁定 — 技能文档示例", () => {
  it("技能「方案依赖文件」节的示例可被解析且无告警", () => {
    const serials = ["QHDK-29749", "QHDK-29750"];
    const deps = parsePlanDeps(SKILL_DOC_EXAMPLE, serials);
    expect(deps.warnings).toEqual([]);
    expect(deps.graph).toEqual({ "QHDK-29749": [], "QHDK-29750": ["QHDK-29749"] });
    expect(deps.executionOrder).toEqual(serials);
  });

  it("示例的拓扑序满足硬依赖（前置在前）", () => {
    const serials = ["QHDK-29749", "QHDK-29750"];
    const deps = parsePlanDeps(SKILL_DOC_EXAMPLE, serials);
    expect(topoSortPlanIssues(serials, deps.graph, deps.executionOrder)).toEqual(serials);
    expect(unmetDependencies(deps.graph, "QHDK-29750", () => false)).toEqual(["QHDK-29749"]);
  });
});

describe("planDepsPath — 与后端注入路径同约定", () => {
  it("与 plan.md 同目录、文件名为 deps.json", () => {
    expect(planDepsPath("H:/proj", "p1")).toBe("H:/proj/.nezha/plans/p1/deps.json");
    expect(planDepsPath("H:/proj", "p1").replace(/deps\.json$/, "plan.md")).toBe(
      planMdPath("H:/proj", "p1"),
    );
  });

  it("容忍项目路径末尾的斜杠/反斜杠", () => {
    expect(planDepsPath("H:/proj/", "p1")).toBe("H:/proj/.nezha/plans/p1/deps.json");
    expect(planDepsPath("H:\\proj\\", "p1")).toBe("H:\\proj/.nezha/plans/p1/deps.json");
  });
});

/** 契约示例文件：A → B（B 依赖 A）。 */
const VALID_DEPS = JSON.stringify({
  version: 1,
  issues: [
    { serialNumber: "QHDK-A", dependsOn: [] },
    { serialNumber: "QHDK-B", dependsOn: ["QHDK-A"] },
  ],
  executionOrder: ["QHDK-A", "QHDK-B"],
});

describe("parsePlanDeps — 缺失与损坏", () => {
  it("文件缺失 / 空白 → 按无依赖处理，图内每个议题都有空键", () => {
    for (const raw of [null, undefined, "", "   \n  "]) {
      const deps = parsePlanDeps(raw, ["A", "B"]);
      expect(deps.graph).toEqual({ A: [], B: [] });
      expect(deps.executionOrder).toEqual(["A", "B"]);
      expect(kinds(deps)).toEqual(["missing"]);
    }
  });

  it("JSON 损坏 → malformed，但仍返回可用的空图（不阻断任务启动）", () => {
    const deps = parsePlanDeps("{ this is not json", ["A", "B"]);
    expect(deps.graph).toEqual({ A: [], B: [] });
    expect(deps.executionOrder).toEqual(["A", "B"]);
    expect(kinds(deps)).toEqual(["malformed"]);
  });

  it("顶层不是对象 → malformed", () => {
    for (const raw of ["[1,2]", '"text"', "3", "null"]) {
      const deps = parsePlanDeps(raw, ["A"]);
      expect(kinds(deps)).toEqual(["malformed"]);
      expect(deps.graph).toEqual({ A: [] });
    }
  });

  it("未知的 version → 记 malformed 提示，依赖仍照常解析", () => {
    const raw = JSON.stringify({ version: 2, issues: [{ serialNumber: "B", dependsOn: ["A"] }] });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(kinds(deps)).toEqual(["malformed"]);
    expect(deps.warnings[0].detail).toContain("版本");
    expect(deps.graph.B).toEqual(["A"]);
  });

  it("只有 executionOrder、没有 issues → 合法且不产生告警", () => {
    const raw = JSON.stringify({ version: 1, executionOrder: ["B", "A"] });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(deps.warnings).toEqual([]);
    expect(deps.executionOrder).toEqual(["B", "A"]);
  });

  it("issues 不是数组 → malformed，不产生依赖", () => {
    const raw = JSON.stringify({ version: 1, issues: { A: [] } });
    const deps = parsePlanDeps(raw, ["A"]);
    expect(kinds(deps)).toEqual(["malformed"]);
    expect(deps.graph).toEqual({ A: [] });
  });
});

describe("parsePlanDeps — 正常解析", () => {
  it("解析出硬依赖与执行顺序", () => {
    const deps = parsePlanDeps(VALID_DEPS, ["QHDK-A", "QHDK-B"]);
    expect(deps.warnings).toEqual([]);
    expect(deps.graph).toEqual({ "QHDK-A": [], "QHDK-B": ["QHDK-A"] });
    expect(deps.executionOrder).toEqual(["QHDK-A", "QHDK-B"]);
  });

  it("去重编号：planSerials 重复 / 含空白时归一化", () => {
    const deps = parsePlanDeps(
      JSON.stringify({ version: 1, issues: [{ serialNumber: " B ", dependsOn: ["A"] }] }),
      ["A", "A", " B "],
    );
    expect(deps.graph).toEqual({ A: [], B: ["A"] });
  });

  it("同一议题出现多条 entry → dependsOn 取并集并去重", () => {
    const raw = JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "C", dependsOn: ["A"] },
        { serialNumber: "C", dependsOn: ["A", "B"] },
      ],
    });
    const deps = parsePlanDeps(raw, ["A", "B", "C"]);
    expect(deps.graph.C).toEqual(["A", "B"]);
  });

  it("缺 serialNumber 的 entry → malformed 且跳过", () => {
    const raw = JSON.stringify({ version: 1, issues: [{ dependsOn: ["A"] }] });
    const deps = parsePlanDeps(raw, ["A"]);
    expect(kinds(deps)).toEqual(["malformed"]);
    expect(deps.graph).toEqual({ A: [] });
  });
});

describe("parsePlanDeps — 越界编号与自依赖", () => {
  it("方案外议题 → unknownIssue，且不为它建节点", () => {
    const raw = JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "B", dependsOn: ["A"] },
        { serialNumber: "QHDK-OUTSIDE", dependsOn: [] },
      ],
    });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(Object.keys(deps.graph).sort()).toEqual(["A", "B"]);
    const unknown = deps.warnings.find((w) => w.kind === "unknownIssue");
    expect(unknown?.serialNumbers).toEqual(["QHDK-OUTSIDE"]);
  });

  it("dependsOn 指向方案外编号 → 该边丢弃 + unknownDependency", () => {
    const raw = JSON.stringify({
      version: 1,
      issues: [{ serialNumber: "B", dependsOn: ["A", "QHDK-OUTSIDE"] }],
    });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(deps.graph.B).toEqual(["A"]);
    const unknown = deps.warnings.find((w) => w.kind === "unknownDependency");
    expect(unknown?.serialNumbers).toEqual(["B", "QHDK-OUTSIDE"]);
  });

  it("自依赖 → 丢弃该边 + selfDependency", () => {
    const raw = JSON.stringify({ version: 1, issues: [{ serialNumber: "A", dependsOn: ["A"] }] });
    const deps = parsePlanDeps(raw, ["A"]);
    expect(deps.graph.A).toEqual([]);
    expect(kinds(deps)).toEqual(["selfDependency"]);
  });

  it("dependsOn 非数组 / 含非字符串项 → malformed 且该边丢弃", () => {
    const nonArray = parsePlanDeps(
      JSON.stringify({ version: 1, issues: [{ serialNumber: "B", dependsOn: "A" }] }),
      ["A", "B"],
    );
    expect(nonArray.graph.B).toEqual([]);
    expect(kinds(nonArray)).toEqual(["malformed"]);

    const mixed = parsePlanDeps(
      JSON.stringify({ version: 1, issues: [{ serialNumber: "B", dependsOn: ["A", 7] }] }),
      ["A", "B"],
    );
    expect(mixed.graph.B).toEqual(["A"]);
    expect(kinds(mixed)).toEqual(["malformed"]);
  });
});

describe("parsePlanDeps — 成环", () => {
  it("二元环 → 环上边全部丢弃 + cycle 告警，图变为无环", () => {
    const raw = JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "A", dependsOn: ["B"] },
        { serialNumber: "B", dependsOn: ["A"] },
      ],
    });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(deps.graph).toEqual({ A: [], B: [] });
    const cycle = deps.warnings.find((w) => w.kind === "cycle");
    expect(cycle?.serialNumbers).toEqual(["A", "B"]);
  });

  it("三元环 → 只丢弃环内边，环外正常依赖保留", () => {
    // A 无依赖；B 依赖 A 与 C；C 依赖 B（B↔C 成环）；D 依赖 C。
    const raw = JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "A", dependsOn: [] },
        { serialNumber: "B", dependsOn: ["A", "C"] },
        { serialNumber: "C", dependsOn: ["B"] },
        { serialNumber: "D", dependsOn: ["C"] },
      ],
    });
    const deps = parsePlanDeps(raw, ["A", "B", "C", "D"]);
    expect(deps.graph).toEqual({ A: [], B: ["A"], C: [], D: ["C"] });
    expect(deps.warnings.filter((w) => w.kind === "cycle")).toHaveLength(1);
  });

  it("破环后的图一定可拓扑排序（不丢议题）", () => {
    const raw = JSON.stringify({
      version: 1,
      issues: [
        { serialNumber: "A", dependsOn: ["C"] },
        { serialNumber: "B", dependsOn: ["A"] },
        { serialNumber: "C", dependsOn: ["B"] },
      ],
    });
    const deps = parsePlanDeps(raw, ["A", "B", "C"]);
    const order = topoSortPlanIssues(["A", "B", "C"], deps.graph, deps.executionOrder);
    expect([...order].sort()).toEqual(["A", "B", "C"]);
  });
});

describe("parsePlanDeps — 执行顺序归一化", () => {
  it("过滤方案外编号与重复项，缺失议题按 planSerials 顺序补尾", () => {
    const raw = JSON.stringify({ version: 1, executionOrder: ["C", "QHDK-OUTSIDE", "C", "A"] });
    const deps = parsePlanDeps(raw, ["A", "B", "C"]);
    expect(deps.executionOrder).toEqual(["C", "A", "B"]);
  });

  it("executionOrder 非数组 → malformed 并回落 planSerials 顺序", () => {
    const raw = JSON.stringify({ version: 1, executionOrder: "A" });
    const deps = parsePlanDeps(raw, ["A", "B"]);
    expect(kinds(deps)).toEqual(["malformed"]);
    expect(deps.executionOrder).toEqual(["A", "B"]);
  });
});

describe("topoSortPlanIssues", () => {
  it("前置排在后继之前，即使入参顺序倒置", () => {
    const graph = { C: ["B"], B: ["A"], A: [] };
    expect(topoSortPlanIssues(["C", "B", "A"], graph)).toEqual(["A", "B", "C"]);
  });

  it("无依赖时按 executionOrder 排序", () => {
    expect(topoSortPlanIssues(["A", "B", "C"], {}, ["C", "A", "B"])).toEqual(["C", "A", "B"]);
  });

  it("无 executionOrder 时回落 planSerials 给定顺序", () => {
    expect(topoSortPlanIssues(["C", "A", "B"], {})).toEqual(["C", "A", "B"]);
  });

  it("同层就绪时 executionOrder 优先于 planSerials", () => {
    // B、C 都只依赖 A：A 之后按 executionOrder（C 先）而不是 planSerials（B 先）。
    const graph = { A: [], B: ["A"], C: ["A"] };
    expect(topoSortPlanIssues(["A", "B", "C"], graph, ["A", "C", "B"])).toEqual(["A", "C", "B"]);
  });

  it("防御性：即使传入带环的图也不丢议题、不空转", () => {
    const order = topoSortPlanIssues(["A", "B"], { A: ["B"], B: ["A"] });
    expect([...order].sort()).toEqual(["A", "B"]);
  });

  it("忽略图中指向方案外的依赖", () => {
    const order = topoSortPlanIssues(["A", "B"], { A: ["QHDK-OUTSIDE"], B: [] });
    expect([...order].sort()).toEqual(["A", "B"]);
  });
});

describe("unmetDependencies", () => {
  it("返回尚未满足的直接前置，保持图内顺序", () => {
    const graph = { D: ["B", "A", "C"] };
    expect(unmetDependencies(graph, "D", (serial) => serial === "A")).toEqual(["B", "C"]);
  });

  it("全部满足 → 空数组；议题无前置 → 空数组", () => {
    const graph = { D: ["A"], E: [] };
    expect(unmetDependencies(graph, "D", () => true)).toEqual([]);
    expect(unmetDependencies(graph, "E", () => false)).toEqual([]);
  });
});
