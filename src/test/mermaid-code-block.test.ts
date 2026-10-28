import { describe, expect, it } from "vitest";
import {
  isMermaidLanguage,
  isLikelyMermaidCode,
  resolveMermaidAutoRenderDecision,
  shouldRenderMermaidCodeBlock,
} from "../utils/mermaidLanguage";
import { renderMessageMarkdown, renderMessageMarkdownSegments } from "../utils/markdown";

describe("mermaid 语言识别", () => {
  it("显式 mermaid / mmd 标注直接命中", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("  MERMAID ")).toBe(true);
    expect(isMermaidLanguage("mmd")).toBe(true);
    expect(isMermaidLanguage("ts")).toBe(false);
  });

  it("空语言或纯文本语言按首行图表关键字识别", () => {
    expect(isLikelyMermaidCode("flowchart TD\n A --> B")).toBe(true);
    expect(isLikelyMermaidCode("graph LR\nA-->B")).toBe(true);
    expect(isLikelyMermaidCode("sequenceDiagram\n A->>B: hi")).toBe(true);
    expect(isLikelyMermaidCode("stateDiagram-v2\n [*] --> s1")).toBe(true);
    // frontmatter 指令块跳过后再看首行
    expect(isLikelyMermaidCode("---\ntitle: x\n---\nflowchart TD\n A-->B")).toBe(true);
    expect(isLikelyMermaidCode("const x = 1")).toBe(false);
    expect(isLikelyMermaidCode("")).toBe(false);
  });

  it("显式 ts/js 等语言永不误判成图表", () => {
    expect(shouldRenderMermaidCodeBlock("ts", "flowchart TD\n A-->B")).toBe(false);
    expect(shouldRenderMermaidCodeBlock("sh", "graph TD")).toBe(false);
  });

  it("无语言的 flowchart 命中（模型经常不标语言）", () => {
    expect(shouldRenderMermaidCodeBlock("", "flowchart TD\n    Task[任务] --> Router[路由]")).toBe(true);
    expect(shouldRenderMermaidCodeBlock("text", "pie\n  \"a\": 1")).toBe(true);
    expect(shouldRenderMermaidCodeBlock("mermaid", "anything")).toBe(true);
  });
});

describe("mermaid 渲染预算门禁", () => {
  it("常规大小图表放行", () => {
    expect(resolveMermaidAutoRenderDecision("flowchart TD\n A --> B").shouldRender).toBe(true);
  });

  it("超大源码拒绝", () => {
    const big = "flowchart TD\n" + "a".repeat(21_000);
    const decision = resolveMermaidAutoRenderDecision(big);
    expect(decision.shouldRender).toBe(false);
    expect(decision.reason).toBe("source-too-large");
  });

  it("超多行拒绝", () => {
    const manyLines = Array.from({ length: 601 }, (_, i) => `n${i}`).join("\n");
    const decision = resolveMermaidAutoRenderDecision(manyLines);
    expect(decision.shouldRender).toBe(false);
    expect(decision.reason).toBe("too-many-lines");
  });
});

describe("renderMessageMarkdownSegments 切段", () => {
  it("纯文本无 mermaid 时输出单个 html 段，内容与整体渲染一致", () => {
    const text = "# 标题\n\n正文 **加粗** 换行\n第二行";
    const segments = renderMessageMarkdownSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].type).toBe("html");
    expect((segments[0] as { html: string }).html).toBe(renderMessageMarkdown(text));
  });

  it("显式 mermaid 代码块切出 mermaid 段", () => {
    const text = "前言段落\n\n```mermaid\nflowchart TD\n A --> B\n```\n\n结尾段落";
    const segments = renderMessageMarkdownSegments(text);
    expect(segments.map((s) => s.type)).toEqual(["html", "mermaid", "html"]);
    expect((segments[1] as { code: string }).code).toContain("A --> B");
  });

  it("无语言的 flowchart 代码块也切出 mermaid 段（模型经常不标语言）", () => {
    const text = "```\nflowchart TD\n A --> B\n```";
    const segments = renderMessageMarkdownSegments(text);
    expect(segments.map((s) => s.type)).toEqual(["mermaid"]);
  });

  it("ts 代码块不误判成图表", () => {
    const text = "```ts\nconst a = 1;\n```";
    const segments = renderMessageMarkdownSegments(text);
    expect(segments.map((s) => s.type)).toEqual(["html"]);
  });

  it("普通代码块渲染为 pre/code，与整体渲染一致", () => {
    const text = "```\nline1\nline2\n```";
    const segments = renderMessageMarkdownSegments(text);
    expect(segments).toHaveLength(1);
    expect((segments[0] as { html: string }).html).toBe(renderMessageMarkdown(text));
  });

  it("列表软换行语义与 renderMessageMarkdown 一致（breaks: true）", () => {
    const text = "1. **小标题**\n   正文内容";
    const segments = renderMessageMarkdownSegments(text);
    expect((segments[0] as { html: string }).html).toBe(renderMessageMarkdown(text));
  });

  it("html 段拼接后与整体渲染一致（切段无损）", () => {
    const text = "前文\n\n```mermaid\nflowchart TD\n A --> B\n```\n\n中文\n\n```ts\nconst x = 2;\n```\n\n后文";
    const segments = renderMessageMarkdownSegments(text);
    const joinedHtml = segments
      .filter((s) => s.type === "html")
      .map((s) => (s as { html: string }).html)
      .join("");
    const wholeWithoutMermaid = renderMessageMarkdown(
      text.replace(/```mermaid\n[\s\S]*?```/, "").replace("\n\n\n\n", "\n\n"),
    );
    // 拼接结果应包含整体渲染的非 mermaid 全部内容块
    for (const chunk of wholeWithoutMermaid.split("</p>")) {
      if (chunk.trim()) {
        expect(joinedHtml).toContain(chunk.slice(0, 40));
      }
    }
  });
});
