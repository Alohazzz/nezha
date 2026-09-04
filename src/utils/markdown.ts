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
 */
export function renderMarkdownWithToc(content: string): { html: string; toc: TocEntry[] } {
  const used = new Set<string>();
  const toc: TocEntry[] = [];
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
    },
  });
  const html = instance.parse(content, { async: false }) as string;
  return { html: DOMPurify.sanitize(html), toc };
}
