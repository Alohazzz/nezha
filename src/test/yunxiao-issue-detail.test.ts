import { beforeEach, describe, expect, it } from "vitest";
import {
  buildYunxiaoIssueLink,
  getLastYunxiaoAgent,
  setLastYunxiaoAgent,
} from "../utils/yunxiao";
import {
  buildSupplementedPrompt,
  categoryToFormKind,
} from "../components/yunxiao/issueForms";

const PROJECT_ID = "07a763450c8733172523320ab6";
const WORKITEM_ID = "741d91e70b392b65ef95604c1f";

describe("categoryToFormKind", () => {
  it("Req 与 Task 映射为需求表单", () => {
    expect(categoryToFormKind("Req")).toBe("requirement");
    expect(categoryToFormKind("Task")).toBe("requirement");
  });

  it("Bug 映射为缺陷表单", () => {
    expect(categoryToFormKind("Bug")).toBe("bug");
  });

  it("缺失或未知类别回退需求表单（小写 bug 也防御性识别）", () => {
    expect(categoryToFormKind(undefined)).toBe("requirement");
    expect(categoryToFormKind("")).toBe("requirement");
    expect(categoryToFormKind("bug")).toBe("bug");
  });
});

describe("buildYunxiaoIssueLink", () => {
  it("按项目与工作项 ID 构造云效详情页链接", () => {
    expect(buildYunxiaoIssueLink(PROJECT_ID, WORKITEM_ID)).toBe(
      `https://devops.aliyun.com/projex/project/${PROJECT_ID}/workitem/${WORKITEM_ID}`,
    );
  });
});

describe("lastYunxiaoAgent 记忆", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("写入后可读回，且按项目隔离", () => {
    setLastYunxiaoAgent("p-1", "codex");
    setLastYunxiaoAgent("p-2", "claude");
    expect(getLastYunxiaoAgent("p-1")).toBe("codex");
    expect(getLastYunxiaoAgent("p-2")).toBe("claude");
  });

  it("未写入或写入非法值时返回 null", () => {
    expect(getLastYunxiaoAgent("p-1")).toBeNull();
    localStorage.setItem("nezha:lastYunxiaoAgent:p-1", "gpt");
    expect(getLastYunxiaoAgent("p-1")).toBeNull();
  });

  it("切换项目互不影响", () => {
    setLastYunxiaoAgent("p-1", "dsh");
    expect(getLastYunxiaoAgent("p-2")).toBeNull();
  });
});

describe("buildSupplementedPrompt", () => {
  it("需求表单：按字段顺序拼入标题/痛点/期望/备选，跳过空字段，保留原文与链接", () => {
    const prompt = buildSupplementedPrompt(
      "requirement",
      {
        subject: "任务列表加「只看 starred」筛选",
        pain: "starred 一多就淹没在列表里",
        expectation: "侧边栏加 toggle，只显示 starred",
        alternative: "按 star 排序而不是筛选",
        notes: "",
      },
      "原始议题描述……",
      `https://devops.aliyun.com/projex/project/${PROJECT_ID}/workitem/${WORKITEM_ID}`,
    );
    expect(prompt).toContain("标题: 任务列表加「只看 starred」筛选");
    expect(prompt).toContain("当前痛点: starred 一多就淹没在列表里");
    expect(prompt).toContain("期望行为: 侧边栏加 toggle，只显示 starred");
    expect(prompt).toContain("备选方案: 按 star 排序而不是筛选");
    expect(prompt).not.toContain("补充说明:");
    expect(prompt).toContain("原始议题描述……");
    expect(prompt).toContain("云效链接：https://devops.aliyun.com/projex");
  });

  it("缺陷表单：包含问题描述/复现/回归字段", () => {
    const prompt = buildSupplementedPrompt(
      "bug",
      {
        subject: "快速切换项目任务列表空白",
        problem: "连续快速切换 5 个项目后列表偶发空白",
        expectation: "切项目后立即显示任务",
        repro: "运行 scripts/repro.ps1",
        regression: "abc1234 之前是好的",
        notes: "",
      },
      "原文",
      "https://example.com/link",
    );
    expect(prompt).toContain("问题描述: 连续快速切换 5 个项目后列表偶发空白");
    expect(prompt).toContain("复现步骤: 运行 scripts/repro.ps1");
    expect(prompt).toContain("回归信息: abc1234 之前是好的");
    expect(prompt).toContain("云效链接：https://example.com/link");
  });
});
