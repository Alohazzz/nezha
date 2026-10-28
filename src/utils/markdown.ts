import { Marked, marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { resolveMermaidAutoRenderDecision, shouldRenderMermaidCodeBlock } from "./mermaidLanguage";

export type TocEntry = { depth: number; text: string; id: string };

export type MessageMarkdownSegment =
  | { type: "html"; html: string }
  | { type: "mermaid"; code: string; autoRender: boolean };

/**
 * 智能体正文（会话消息 / 计划 / 评审报告）的 Markdown 渲染。
 *
 * 与 `renderMarkdownWithToc` 的区别只在软换行：模型经常写成「`1. **小标题**` 换行
 * 再缩进写正文」，CommonMark 会把单换行折叠成空格，界面上标题和正文并成一行。
 * 这类文本是给人看的对话回复，语义上每行都是有意断行，所以按硬换行渲染
 * （与 GitHub 评论区、ChatGPT 的观感一致）。
 *
 * 真实 `.md` 文件预览不能走这里——那里的软换行属于文档排版，必须保持 CommonMark 语义。
 */
export function renderMessageMarkdown(text: string): string {
  return marked(text, { async: false, breaks: true }) as string;
}

/**
 * 把消息 markdown 按「mermaid 代码块」切段：html 段是整段渲染的 HTML 片段，
 * mermaid 段交给 React 组件动态渲染成 SVG。
 *
 * 为什么切段而不是在 HTML 里塞占位符再 hydrate：消息正文经 `dangerouslySetInnerHTML`
 * 整体注入，React 无法在注入的 DOM 里挂组件。在 marked 的**块级 token 边界**上
 * 切开，每个子串仍是合法的独立 markdown 文档（fenced code block 不会被从中间
 * 截断），html 段顺序拼接后与整体渲染等价——SessionView 的复制全文、导出等
 * 功能不受影响。
 *
 * 真实 `.md` 文件预览（renderMarkdownWithToc）不走这里，保持 CommonMark 语义。
 */
export function renderMessageMarkdownSegments(text: string): MessageMarkdownSegment[] {
  const segments: MessageMarkdownSegment[] = [];
  let htmlBuffer = "";

  const flushHtml = () => {
    if (htmlBuffer) {
      segments.push({ type: "html", html: htmlBuffer });
      htmlBuffer = "";
    }
  };

  const instance = new Marked();
  const tokens = instance.lexer(text);
  for (const token of tokens) {
    if (
      token.type === "code" &&
      shouldRenderMermaidCodeBlock((token as Tokens.Code).lang ?? "", (token as Tokens.Code).text)
    ) {
      const code = (token as Tokens.Code).text;
      // 未过预算门禁的超大图表仍按普通代码块渲染，避免布局计算卡死 UI。
      if (resolveMermaidAutoRenderDecision(code).shouldRender) {
        flushHtml();
        segments.push({ type: "mermaid", code, autoRender: true });
        continue;
      }
    }
    // 每个小块单独 parse 再拼接（breaks 语义与 renderMessageMarkdown 一致）。
    htmlBuffer += instance.parse(token.raw, { async: false, breaks: true }) as string;
  }
  flushHtml();
  return segments;
}

export function isMarkdownFileName(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

/**
 * Render markdown to sanitized HTML and extract a table of contents in a single
 * pass, so heading ids in the HTML and the TOC anchors are guaranteed to match.
 *
 * `highlightTexts`（可选）：命中的列表项会加 `kg-new-entry` 类，用于知识库卡片预览时
 * 高亮「未发布的新增条目」。匹配按**纯文本包含**（已剥标签），容忍条目内的行内格式。
 */
export function renderMarkdownWithToc(
  content: string,
  options: { highlightTexts?: string[] } = {},
): { html: string; toc: TocEntry[] } {
  const used = new Set<string>();
  const toc: TocEntry[] = [];
  const highlightTexts = (options.highlightTexts ?? []).filter((text) => text.trim());
  const instance = new Marked({
    renderer: {
      heading(token) {
        const inlineHtml = this.parser.parseInline(token.tokens);
        const plain = inlineHtml.replace(/<[^>]*>/g, "").trim();
        const base =
          plain
            .toLowerCase()
            .replace(/[^\w一-龥 -]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "") || "section";
        let id = base;
        let n = 1;
        while (used.has(id)) id = `${base}-${n++}`;
        used.add(id);
        toc.push({ depth: token.depth, text: plain, id });
        return `<h${token.depth} id="${id}">${inlineHtml}</h${token.depth}>\n`;
      },
      // 仅当有待高亮文本时才接管 listitem，避免无谓地偏离 marked 默认渲染。
      ...(highlightTexts.length > 0
        ? {
            listitem(token: { tokens: unknown[] }) {
              const body = this.parser.parse(token.tokens as never);
              const plain = body.replace(/<[^>]*>/g, "");
              const isNew = highlightTexts.some((text) => plain.includes(text));
              return `<li${isNew ? ' class="kg-new-entry"' : ""}>${body}</li>\n`;
            },
          }
        : {}),
    },
  });
  const html = instance.parse(content, { async: false }) as string;
  return { html: DOMPurify.sanitize(html), toc };
}
