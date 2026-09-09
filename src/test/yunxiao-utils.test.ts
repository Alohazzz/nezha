import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../types";
import {
  buildYunxiaoConditions,
  ensureIssueTagInMessage,
  isYunxiaoWorkitemImported,
  issueTag,
  messageHasIssueTag,
  splitValueScoreSection,
} from "../utils/yunxiao";

function baseTask(extra: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    projectId: "p-1",
    prompt: "prompt",
    agent: "claude",
    permissionMode: "ask",
    status: "todo",
    createdAt: 1787000000000,
    ...extra,
  };
}

function basePlan(extra: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    projectId: "p-1",
    name: "",
    issues: [
      {
        workitemId: "741d91e70b392b65ef95604c1f",
        serialNumber: "QHDK-29728",
        subject: "议题",
        category: "Req",
      },
    ],
    status: "draft",
    createdAt: 1787000000000,
    ...extra,
  };
}

describe("isYunxiaoWorkitemImported", () => {
  const WORKITEM_ID = "741d91e70b392b65ef95604c1f";

  it("存在相同 yunxiaoWorkitemId 的任务时返回 true", () => {
    const tasks = [baseTask({ yunxiaoWorkitemId: WORKITEM_ID })];
    expect(isYunxiaoWorkitemImported(tasks, [], WORKITEM_ID)).toBe(true);
  });

  it("没有匹配任务与方案时返回 false", () => {
    expect(isYunxiaoWorkitemImported([], [], WORKITEM_ID)).toBe(false);
  });

  it("空 id 不匹配任何任务", () => {
    const tasks = [baseTask({ yunxiaoWorkitemId: WORKITEM_ID })];
    expect(isYunxiaoWorkitemImported(tasks, [], "")).toBe(false);
  });

  it("仍被存活任务引用的方案占用议题（讨论中/待生成待办/执行中/已完成）", () => {
    const discussion = baseTask({ id: "t-disc", planId: "plan-1" });
    for (const status of ["draft", "finalized", "executing", "completed"] as const) {
      expect(
        isYunxiaoWorkitemImported([discussion], [basePlan({ status })], WORKITEM_ID),
      ).toBe(true);
    }
  });

  it("孤儿方案（引用它的任务已删除）不占用议题——修复删任务后无法重新导入", () => {
    expect(isYunxiaoWorkitemImported([], [basePlan({ status: "finalized" })], WORKITEM_ID)).toBe(
      false,
    );
  });

  it("方案被其他议题的任务引用时仍占用其全部议题", () => {
    const todo = baseTask({ id: "t-todo", planId: "plan-1", yunxiaoWorkitemId: "other" });
    expect(isYunxiaoWorkitemImported([todo], [basePlan({ status: "executing" })], WORKITEM_ID)).toBe(
      true,
    );
  });

  it("已取消方案的议题不占用（可重新发起讨论）", () => {
    const discussion = baseTask({ id: "t-disc", planId: "plan-1" });
    expect(
      isYunxiaoWorkitemImported([discussion], [basePlan({ status: "cancelled" })], WORKITEM_ID),
    ).toBe(false);
  });

  it("方案不含该议题时不占用", () => {
    const discussion = baseTask({ id: "t-disc", planId: "plan-1" });
    const other = basePlan({
      issues: [
        { workitemId: "other", serialNumber: "QHDK-1", subject: "其他", category: "Req" },
      ],
    });
    expect(isYunxiaoWorkitemImported([discussion], [other], WORKITEM_ID)).toBe(false);
  });
});

describe("buildYunxiaoConditions", () => {
  it("没有任何过滤条件时返回 undefined", () => {
    expect(buildYunxiaoConditions({})).toBeUndefined();
    expect(buildYunxiaoConditions({ query: "  " })).toBeUndefined();
    expect(
      buildYunxiaoConditions({ assignedToMe: true, currentUserId: "" }),
    ).toBeUndefined();
    expect(buildYunxiaoConditions({ selectedStatusIds: [] })).toBeUndefined();
  });

  it("搜索词生成 subject CONTAINS 条件并 trim", () => {
    const conditions = JSON.parse(buildYunxiaoConditions({ query: "  试剂  " })!);
    expect(conditions.conditionGroups).toHaveLength(1);
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "string",
        fieldIdentifier: "subject",
        format: "input",
        operator: "CONTAINS",
        toValue: null,
        value: ["试剂"],
      },
    ]);
  });

  it("开启我负责的且存在当前用户 ID 时生成 assignedTo 条件", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({
        assignedToMe: true,
        currentUserId: "642b88712ca4e1cd30de4718",
      })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "user",
        fieldIdentifier: "assignedTo",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["642b88712ca4e1cd30de4718"],
      },
    ]);
  });

  it("query 为单个议题编号时走 serialNumber 精确查询（大小写归一）", () => {
    const conditions = JSON.parse(buildYunxiaoConditions({ query: "qhdk-30074" })!);
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "string",
        fieldIdentifier: "serialNumber",
        format: "input",
        operator: "CONTAINS",
        toValue: null,
        value: ["QHDK-30074"],
      },
    ]);
  });

  it("query 含编号加其他文字时仍走标题搜索（编号 NOT 全等 query）", () => {
    const conditions = JSON.parse(buildYunxiaoConditions({ query: "QHDK-30074 医嘱" })!);
    expect(conditions.conditionGroups[0][0].fieldIdentifier).toBe("subject");
    expect(conditions.conditionGroups[0][0].value).toEqual(["QHDK-30074 医嘱"]);
  });

  it("状态多选生成 status CONTAINS 条件并保留全部选中 id", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({ selectedStatusIds: ["100005", "100006"] })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "status",
        fieldIdentifier: "status",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["100005", "100006"],
      },
    ]);
  });

  it("三个条件组合时放在同一条件组（AND 语义）", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({
        query: "医保",
        assignedToMe: true,
        currentUserId: "u-1",
        selectedStatusIds: ["100005", "100006"],
      })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "string",
        fieldIdentifier: "subject",
        format: "input",
        operator: "CONTAINS",
        toValue: null,
        value: ["医保"],
      },
      {
        className: "user",
        fieldIdentifier: "assignedTo",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["u-1"],
      },
      {
        className: "status",
        fieldIdentifier: "status",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["100005", "100006"],
      },
    ]);
  });
});

describe("issueTag", () => {
  it("编号前补 #", () => {
    expect(issueTag("QHDK-29312")).toBe("#QHDK-29312");
  });

  it("已带 # 不重复加", () => {
    expect(issueTag("#QHDK-29312")).toBe("#QHDK-29312");
  });

  it("空编号返回空串", () => {
    expect(issueTag("  ")).toBe("");
  });
});

describe("messageHasIssueTag / ensureIssueTagInMessage", () => {
  it("消息已含 tag（大小写不敏感）时不再追加", () => {
    expect(messageHasIssueTag("fix: 修复查询报错 #qhdk-29312", "QHDK-29312")).toBe(true);
    expect(ensureIssueTagInMessage("fix: 修复查询报错 #QHDK-29312", "QHDK-29312")).toBe(
      "fix: 修复查询报错 #QHDK-29312",
    );
  });

  it("缺 tag 时追加到消息末尾", () => {
    expect(ensureIssueTagInMessage("fix: 修复查询报错", "QHDK-29312")).toBe(
      "fix: 修复查询报错\n\n#QHDK-29312",
    );
  });

  it("空编号视为无需关联", () => {
    expect(messageHasIssueTag("fix: 任意提交", "")).toBe(true);
    expect(ensureIssueTagInMessage("fix: 任意提交", "")).toBe("fix: 任意提交");
  });
});

describe("splitValueScoreSection", () => {
  it("从中间剥离评分小节并解析核心指数", () => {
    const text = [
      "开头总结",
      "",
      "## 价值评分（issue-value-scoring · 2026-08-24）",
      "",
      "- 核心指数：**12.0** = (2 × 3 × 4) ÷ 2",
      "",
      "## 结尾备注",
      "",
      "补充说明",
    ].join("\n");
    const result = splitValueScoreSection(text);
    expect(result.comment).toBe("开头总结\n\n## 结尾备注\n\n补充说明");
    expect(result.scoreSection?.startsWith("## 价值评分")).toBe(true);
    expect(result.scoreValue).toBe(12);
  });

  it("解析 Bug 优先指数", () => {
    const text = [
      "## 价值评分（issue-value-scoring · 2026-08-24）",
      "",
      "- 优先指数：**54.0** = 严重 3 × 频率 3 × 范围 3 × 折减 1.0（无绕行）",
      "",
      "- 定级：**P1**（修复成本 4）",
    ].join("\n");
    expect(splitValueScoreSection(text).scoreValue).toBe(54);
  });

  it("无评分小节时原样返回", () => {
    const result = splitValueScoreSection("只有评论内容");
    expect(result.comment).toBe("只有评论内容");
    expect(result.scoreSection).toBeNull();
    expect(result.scoreValue).toBeNull();
  });

  it("小节在末尾时评论只保留前文", () => {
    const text = [
      "开头总结",
      "",
      "## 价值评分（issue-value-scoring · 2026-08-24）",
      "",
      "- 核心指数：**3.5** = (1 × 2 × 3) ÷ 2",
    ].join("\n");
    const result = splitValueScoreSection(text);
    expect(result.comment).toBe("开头总结");
    expect(result.scoreValue).toBe(3.5);
  });
});
