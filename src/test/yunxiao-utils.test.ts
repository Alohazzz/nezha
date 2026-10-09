import { describe, expect, it } from "vitest";
import type { Plan, Task } from "../types";
import {
  buildYunxiaoConditions,
  ensureIssueTagInMessage,
  getYunxiaoPlanEndDate,
  getYunxiaoProduct,
  getYunxiaoStatusTone,
  isYunxiaoIssueOverdue,
  isYunxiaoWorkitemImported,
  issueTag,
  messageHasIssueTag,
  requiresSedimentation,
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

  it("版本多选生成 version CONTAINS 条件（fieldIdentifier 为单数，实测复数无效）", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({
        selectedVersionIds: ["18730c43160bec0fb589b10946", "0ee4a20490dbf8bf7acebd9a43"],
      })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "version",
        fieldIdentifier: "version",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["18730c43160bec0fb589b10946", "0ee4a20490dbf8bf7acebd9a43"],
      },
    ]);
  });

  it("空版本选择不生成条件", () => {
    expect(buildYunxiaoConditions({ selectedVersionIds: [] })).toBeUndefined();
    expect(buildYunxiaoConditions({ selectedVersionIds: ["  "] })).toBeUndefined();
  });

  it("版本与状态同时选中时放在同一条件组（AND 语义）", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({
        selectedStatusIds: ["100005"],
        selectedVersionIds: ["v-1"],
      })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "status",
        fieldIdentifier: "status",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["100005"],
      },
      {
        className: "version",
        fieldIdentifier: "version",
        format: "list",
        operator: "CONTAINS",
        toValue: null,
        value: ["v-1"],
      },
    ]);
  });

  // 回归锁：产品过滤不进 conditions——实测（差分）服务端对自定义字段按文本过滤
  // 不可用（CONTAINS 恒 0 条，IN/= 不过滤全量），产品在 YunxiaoView 本地过滤。
  it("产品选择不生成任何 conditions（回归：服务端不支持按文本过滤自定义字段）", () => {
    expect(
      buildYunxiaoConditions({
        selectedProducts: ["财务管理系统", "实验室信息管理系统（LIS）"],
      }),
    ).toBeUndefined();
  });

  it("计划完成时间范围用字段 ID 拼 BETWEEN 闭区间条件", () => {
    const conditions = JSON.parse(
      buildYunxiaoConditions({
        planEndDateRange: { from: 1759248000000, to: 1761849599999 },
        planEndFieldId: "abc123",
      })!,
    );
    expect(conditions.conditionGroups[0]).toEqual([
      {
        className: "date",
        fieldIdentifier: "abc123",
        format: "input",
        operator: "BETWEEN",
        toValue: null,
        value: ["1759248000000", "1761849599999"],
      },
    ]);
  });

  it("时间范围只填一侧时退化为 GTE/LTE；无字段 ID 不生成条件", () => {
    const gte = JSON.parse(
      buildYunxiaoConditions({
        planEndDateRange: { from: 1759248000000 },
        planEndFieldId: "abc123",
      })!,
    );
    expect(gte.conditionGroups[0][0].operator).toBe("GTE");
    const lte = JSON.parse(
      buildYunxiaoConditions({
        planEndDateRange: { to: 1761849599999 },
        planEndFieldId: "abc123",
      })!,
    );
    expect(lte.conditionGroups[0][0].operator).toBe("LTE");
    expect(
      buildYunxiaoConditions({ planEndDateRange: { from: 1759248000000 } }),
    ).toBeUndefined();
  });
});

describe("requiresSedimentation", () => {
  it("云效执行类任务（有议题、非讨论）要求沉淀", () => {
    expect(
      requiresSedimentation({
        yunxiaoWorkitemId: "741d91e70b392b65ef95604c1f",
        yunxiaoPlanDiscussion: undefined,
      }),
    ).toBe(true);
  });

  it("方案讨论任务不要求沉淀（产出的是方案而非知识）", () => {
    expect(
      requiresSedimentation({
        yunxiaoWorkitemId: "741d91e70b392b65ef95604c1f",
        yunxiaoPlanDiscussion: true,
      }),
    ).toBe(false);
  });

  it("普通任务（无议题绑定，含空提示词启动终端）不要求沉淀", () => {
    expect(requiresSedimentation({})).toBe(false);
    expect(
      requiresSedimentation({ yunxiaoWorkitemId: "", yunxiaoPlanDiscussion: false }),
    ).toBe(false);
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

describe("getYunxiaoProduct", () => {
  const PRODUCT_FIELD_ID = "81571b37063687b4aefd3f16";

  const issueWithCustomFields = (values: Array<{ fieldId: string; displayValue: string }>) => ({
    id: "w-1",
    serialNumber: "QHDK-1",
    subject: "s",
    customFieldValues: values.map((v) => ({
      fieldId: v.fieldId,
      fieldName: "",
      values: [{ identifier: v.displayValue, displayValue: v.displayValue }],
    })),
  });

  it("回归：产品从 customFieldValues 按字段 ID 提取（搜索响应无顶层 product 键）", () => {
    const issue = issueWithCustomFields([
      { fieldId: "12870b90729a20c378a99c94", displayValue: "客户反馈" },
      { fieldId: PRODUCT_FIELD_ID, displayValue: "财务管理系统" },
    ]);
    expect(getYunxiaoProduct(issue as never, PRODUCT_FIELD_ID)).toBe("财务管理系统");
  });

  it("字段 ID 不匹配时返回 undefined（不误取其他自定义字段）", () => {
    const issue = issueWithCustomFields([
      { fieldId: "12870b90729a20c378a99c94", displayValue: "客户反馈" },
    ]);
    expect(getYunxiaoProduct(issue as never, PRODUCT_FIELD_ID)).toBeUndefined();
  });

  it("displayValue 为空串视为无产品", () => {
    const issue = issueWithCustomFields([{ fieldId: PRODUCT_FIELD_ID, displayValue: "" }]);
    expect(getYunxiaoProduct(issue as never, PRODUCT_FIELD_ID)).toBeUndefined();
  });
});

describe("getYunxiaoPlanEndDate", () => {
  const PLAN_FIELD_ID = "plan-field-1";

  it("顶层 planEndDate 优先于自定义字段", () => {
    const issue = {
      id: "w-1",
      serialNumber: "QHDK-1",
      subject: "s",
      planEndDate: 1760486400000,
      customFieldValues: [
        {
          fieldId: PLAN_FIELD_ID,
          fieldName: "计划完成时间",
          values: [{ identifier: "2099/01/01", displayValue: "2099/01/01" }],
        },
      ],
    };
    expect(getYunxiaoPlanEndDate(issue as never, PLAN_FIELD_ID)).toBe(1760486400000);
  });

  it("从自定义字段 displayValue 解析日期字符串（yyyy/mm/dd）", () => {
    const issue = {
      id: "w-1",
      serialNumber: "QHDK-1",
      subject: "s",
      customFieldValues: [
        {
          fieldId: PLAN_FIELD_ID,
          fieldName: "计划完成时间",
          values: [{ identifier: "2026/10/15", displayValue: "2026/10/15" }],
        },
      ],
    };
    expect(getYunxiaoPlanEndDate(issue as never, PLAN_FIELD_ID)).toBe(
      new Date(2026, 9, 15).getTime(),
    );
  });

  it("10 位秒级时间戳自动补齐到毫秒", () => {
    const issue = {
      id: "w-1",
      serialNumber: "QHDK-1",
      subject: "s",
      customFieldValues: [
        {
          fieldId: PLAN_FIELD_ID,
          fieldName: "计划完成时间",
          values: [{ identifier: "1760486400", displayValue: "1760486400" }],
        },
      ],
    };
    expect(getYunxiaoPlanEndDate(issue as never, PLAN_FIELD_ID)).toBe(1760486400000);
  });

  it("无法解析的文本返回 undefined", () => {
    const issue = {
      id: "w-1",
      serialNumber: "QHDK-1",
      subject: "s",
      customFieldValues: [
        {
          fieldId: PLAN_FIELD_ID,
          fieldName: "计划完成时间",
          values: [{ identifier: "待定", displayValue: "待定" }],
        },
      ],
    };
    expect(getYunxiaoPlanEndDate(issue as never, PLAN_FIELD_ID)).toBeUndefined();
  });
});

describe("getYunxiaoStatusTone / isYunxiaoIssueOverdue", () => {
  const mkIssue = (status?: string) => ({
    id: "w-1",
    serialNumber: "QHDK-1",
    subject: "s",
    customFieldValues: [],
    ...(status ? { status: { name: status } } : {}),
  });

  it("四色系映射：蓝=待处理、绿=开发中、橙=测试打回、未知回落灰", () => {
    expect(getYunxiaoStatusTone(mkIssue("待处理") as never)).toBe("blue");
    expect(getYunxiaoStatusTone(mkIssue("开发中") as never)).toBe("green");
    expect(getYunxiaoStatusTone(mkIssue("测试打回") as never)).toBe("orange");
    expect(getYunxiaoStatusTone(mkIssue("自定义工作流状态") as never)).toBe("grey");
  });

  it("非终态且早于今天 00:00 判逾期；终态不判；未来不判", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    expect(isYunxiaoIssueOverdue(mkIssue("开发中") as never, yesterday.getTime())).toBe(true);
    expect(isYunxiaoIssueOverdue(mkIssue("已完成") as never, yesterday.getTime())).toBe(false);
    const tomorrow = yesterday.getTime() + 2 * 86400000;
    expect(isYunxiaoIssueOverdue(mkIssue("开发中") as never, tomorrow)).toBe(false);
    expect(isYunxiaoIssueOverdue(mkIssue("开发中") as never, undefined)).toBe(false);
  });
});
