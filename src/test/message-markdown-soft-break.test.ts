import { describe, expect, it } from "vitest";
import { renderMarkdownWithToc, renderMessageMarkdown } from "../utils/markdown";

/**
 * 模型常把列表项写成「`1. **小标题**` 换行 + 缩进正文」，这是 CommonMark 的软换行。
 * 智能体正文按硬换行渲染（标题与正文分行），而真实 .md 文件预览必须保持文档语义。
 */
describe("renderMessageMarkdown 软换行", () => {
  const listWithSoftBreak = [
    "1. **治疗次数的唯一口径**",
    "   是否确认按医嘱展开？",
    "",
    "2. **同一个就诊多个开单医生**",
    "   推荐：显示去重集合。",
  ].join("\n");

  it("列表项内的软换行渲染为硬换行", () => {
    const html = renderMessageMarkdown(listWithSoftBreak);
    expect(html).toContain("<br>");
    expect(html).toMatch(/<\/strong><br>是否确认按医嘱展开？/);
    expect(html).toMatch(/<\/strong><br>推荐：显示去重集合。/);
  });

  it("段落内的软换行同样保留", () => {
    const html = renderMessageMarkdown("第一行\n第二行");
    expect(html).toContain("<br>");
  });

  it("代码块内容不被改写", () => {
    const html = renderMessageMarkdown("```\nline1\nline2\n```");
    expect(html).not.toContain("<br>");
  });

  it("真实 .md 文件预览保持 CommonMark 语义，不插入硬换行", () => {
    const { html } = renderMarkdownWithToc(listWithSoftBreak);
    expect(html).not.toContain("<br>");
    expect(html).toContain("治疗次数的唯一口径");
  });
});
