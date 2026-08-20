import { describe, expect, it } from "vitest";
import type { Task, YunxiaoWorkitem } from "../types";
import {
  buildYunxiaoConditions,
  buildYunxiaoPrompt,
  buildYunxiaoTaskName,
  ensureIssueTagInMessage,
  isYunxiaoWorkitemImported,
  issueTag,
  messageHasIssueTag,
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

const issue: YunxiaoWorkitem = {
  id: "741d91e70b392b65ef95604c1f",
  serialNumber: "QHDK-29728",
  subject: "【芒市医共体】试剂出库查询，过滤框输入字符就报错",
  description: "在试剂出库查询页面输入过滤字符时直接报错。",
  status: { name: "待处理", nameEn: "To Do", displayName: "待处理", id: "100005" },
  assignedTo: { id: "642b88712ca4e1cd30de4718", name: "许宏民" },
  creator: { id: "644f9087f8c4cdf0a4487992", name: "唐建祖" },
  gmtCreate: 1787042498000,
  customFieldValues: [
    {
      fieldId: "priority",
      fieldName: "优先级",
      values: [{ identifier: "918961294027fce36636f0eca8", displayValue: "高" }],
    },
  ],
  categoryId: "Req",
  logicalStatus: "NORMAL",
};

describe("buildYunxiaoTaskName", () => {
  it("组合议题编号与标题作为任务名", () => {
    expect(buildYunxiaoTaskName(issue)).toBe(
      "QHDK-29728 【芒市医共体】试剂出库查询，过滤框输入字符就报错",
    );
  });
});

describe("buildYunxiaoPrompt", () => {
  it("提示词包含标题、编号、优先级、负责人、状态、描述与云效链接", () => {
    const prompt = buildYunxiaoPrompt(issue);
    expect(prompt).toContain(issue.subject);
    expect(prompt).toContain(issue.serialNumber);
    expect(prompt).toContain("高");
    expect(prompt).toContain("许宏民");
    expect(prompt).toContain("待处理");
    expect(prompt).toContain(issue.description ?? "");
    expect(prompt).toContain(issue.id);
  });
});

describe("isYunxiaoWorkitemImported", () => {
  it("存在相同 yunxiaoWorkitemId 的任务时返回 true", () => {
    const tasks = [baseTask({ yunxiaoWorkitemId: "741d91e70b392b65ef95604c1f" })];
    expect(isYunxiaoWorkitemImported(tasks, "741d91e70b392b65ef95604c1f")).toBe(true);
  });

  it("没有匹配任务时返回 false", () => {
    expect(isYunxiaoWorkitemImported([], "741d91e70b392b65ef95604c1f")).toBe(false);
  });

  it("空 id 不匹配任何任务", () => {
    const tasks = [baseTask({ yunxiaoWorkitemId: "741d91e70b392b65ef95604c1f" })];
    expect(isYunxiaoWorkitemImported(tasks, "")).toBe(false);
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
