import { describe, expect, it } from "vitest";
import type { Task, YunxiaoWorkitem } from "../types";
import {
  buildYunxiaoPrompt,
  buildYunxiaoTaskName,
  isYunxiaoWorkitemImported,
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