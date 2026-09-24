import { describe, expect, it } from "vitest";
import {
  buildDirectExecutionPrompt,
  buildPlanDiscussionPrompt,
} from "../utils/plan";
import { normalizeIssueDescription } from "../utils/yunxiao";
import type { YunxiaoWorkitem } from "../types";

/**
 * 回归：QHDK-30368「发起讨论 / 直接开始」报 os error 206。
 *
 * 云效议题描述是 RICHTEXT `{htmlValue, jsonMLValue}`，正文里可能带**内联 base64 图片**。
 * 修复前该 base64（164K 字符）连同 jsonML 节点名一起进了任务 prompt，把提示词撑到 165K，
 * 而 prompt 是作为命令行参数传给 CLI 的，撞 Windows 32,767 字符上限（CreateProcessW,
 * os error 206）。图片已另存到方案目录 / 任务附件目录并按路径注入，正文只需可读文本。
 *
 * 覆盖所有会内联 description 的 prompt builder：
 * - `buildPlanDiscussionPrompt`  → 单条讨论 / 合并（多云题）讨论 / 待办发起讨论
 * - `buildDirectExecutionPrompt` → 云效列表行「直接开始」/ 待办「直接开始」
 * （`buildPlanExecutionPrompt` 用已定稿方案而非 description，不在影响面内。）
 */
const B64 = "iVBORw0KGgoAAAANSUhEUgAAB4AAAAPn" + "A".repeat(164_230);
const DATA_URI = `data:image/png;base64,${B64}`;
const BODY = "复现步骤：患者开立住院证后按身份证查询。";

/** 真实形态的议题：description 是序列化 RICHTEXT，带内联 base64 + jsonML 节点名。 */
function issueWithInlineImage(id = "c5a4f0de1a8b9ec12d9d1dfada", serial = "QHDK-30368"): YunxiaoWorkitem {
  const htmlValue = `<article class="4ever-article"><p>${BODY}</p><img src="${DATA_URI}"></article>`;
  const jsonMLValue = [
    "root",
    {},
    ["p", {}, ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, BODY]]],
    [
      "img",
      { src: DATA_URI },
      ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, DATA_URI]],
    ],
  ];
  return {
    id,
    serialNumber: serial,
    subject: "【住院收费】入院登记，患者开立了住院证，通过身份证去查询，不会加载医师和住院科室。",
    categoryId: "bug",
    description: JSON.stringify({ htmlValue, jsonMLValue }),
    customFieldValues: [],
  };
}

const IMAGE_PATH =
  "H:\\Project\\Company\\HIS\\.nezha\\plans\\1790243003440\\images\\c5a4f0de1a8b9ec12d9d1dfada\\image-01.png";
const TEXT_PATH =
  "H:\\Project\\Company\\HIS\\.nezha\\plans\\1790243003440\\issues\\c5a4f0de1a8b9ec12d9d1dfada.md";

/** 所有 builder 共用断言：无 base64 / 无 jsonML 节点名 / 远低于命令行上限。 */
function expectCleanPrompts(prompt: string): void {
  expect(prompt).not.toContain("base64");
  expect(prompt).not.toMatch(/^leaf$/m);
  expect(prompt).not.toMatch(/^span$/m);
  expect(prompt).not.toMatch(/^root$/m);
  expect(prompt.length).toBeLessThan(4000);
  expect(prompt.length).toBeLessThan(32767);
}

describe("normalizeIssueDescription — 内联图片与 jsonML 节点名不进正文", () => {
  it("序列化 RICHTEXT 描述归一化后只留可读文本", () => {
    const normalized = normalizeIssueDescription(issueWithInlineImage().description);
    expect(normalized).not.toContain("base64");
    expect(normalized).toContain(BODY);
    expect(normalized.length).toBeLessThan(500);
  });

  it("对象形态与仅 jsonML 形态同样干净", () => {
    const serialized = issueWithInlineImage().description!;
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    for (const variant of [
      JSON.stringify(parsed),
      JSON.stringify({ jsonMLValue: parsed.jsonMLValue }),
    ]) {
      const normalized = normalizeIssueDescription(variant);
      expect(normalized).not.toContain("base64");
      expect(normalized).toContain(BODY);
      expect(normalized.length).toBeLessThan(500);
    }
  });

  /**
   * 纯图片描述（真实形态：htmlValue 为空、jsonML 只有 img 节点）。正文为空可以接受——
   * 图片已按路径注入；但**绝不能**回退成原始 `{htmlValue, jsonMLValue}` JSON，
   * 那会把结构串原样塞进 prompt。
   */
  it("纯图片描述不得回退成原始 JSON", () => {
    const raw = JSON.stringify({
      htmlValue: "",
      jsonMLValue: [
        "root",
        {},
        [
          "p",
          {},
          ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, ""]],
          [
            "img",
            { id: "dcibqp", name: "image.png", size: 259847, src: "https://devops.aliyun.com/x" },
            ["span", { "data-type": "text" }, ["span", { "data-type": "leaf" }, ""]],
          ],
        ],
      ],
    });
    const normalized = normalizeIssueDescription(raw);
    expect(normalized).not.toContain("jsonMLValue");
    expect(normalized).not.toContain("htmlValue");
    expect(normalized).not.toContain("data-type");
  });
});

describe("buildPlanDiscussionPrompt — 单条 / 合并 / 待办讨论共用链路", () => {
  function build(issues: YunxiaoWorkitem[]): string {
    return buildPlanDiscussionPrompt({
      issues,
      issueTextPathByIssue: Object.fromEntries(issues.map((i) => [i.id, TEXT_PATH])),
      imagePathsByIssue: Object.fromEntries(issues.map((i) => [i.id, [IMAGE_PATH]])),
      linksByIssue: { [issues[0].id]: "https://devops.aliyun.com/projex/project/p/workitem/1" },
      instructions: "## 工作流程\n请先读取并遵循 `yunxiao-plan-discussion` 技能。",
    });
  }

  it("单条讨论：只给议题原文路径，正文不进 prompt", () => {
    const prompt = build([issueWithInlineImage()]);
    expectCleanPrompts(prompt);
    expect(prompt).toContain(TEXT_PATH);
    // 正文（含图片占位）已落盘，不再内联。
    expect(prompt).not.toContain(BODY);
  });

  it("合并讨论（多云题）：列出每议题的原文路径，合计远低于命令行上限", () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      issueWithInlineImage(`w-${i}`, `QHDK-304${i}`),
    );
    const prompt = build(issues);
    expectCleanPrompts(prompt);
    // 每个议题都有原文路径（同一夹具路径，按现值断言至少一次）。
    expect(prompt).toContain(TEXT_PATH);
    expect(prompt).not.toContain(BODY);
  });
});

describe("buildDirectExecutionPrompt — 直接开始（列表行 / 待办）", () => {
  function build(issue: YunxiaoWorkitem): string {
    return buildDirectExecutionPrompt({
      issue,
      link: "https://devops.aliyun.com/projex/project/p/workitem/1",
      imagePaths: [IMAGE_PATH],
      instructions: "## 工作流程\n直接执行并进行价值评分、测试简报。",
    });
  }

  it("直接开始：正文已归一化且可读（本入口仍内联，Step 3 再随方案统一改为路径）", () => {
    const prompt = build(issueWithInlineImage());
    expectCleanPrompts(prompt);
    expect(prompt).toContain(BODY);
  });
});
