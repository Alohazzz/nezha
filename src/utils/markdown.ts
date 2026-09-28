import { Marked } from "marked";
import DOMPurify from "dompurify";

export type TocEntry = { depth: number; text: string; id: string };

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
