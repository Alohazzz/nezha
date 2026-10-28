import { useMemo } from "react";
import DOMPurify from "dompurify";
import { renderMessageMarkdownSegments } from "../../utils/markdown";
import { MermaidBlockWithPreview } from "./MermaidBlockWithPreview";

interface MessageMarkdownBodyProps {
  text: string;
  /** 整个正文的容器 class（如 session-prose / md-preview）。html 段的包裹 div 也用它。 */
  className?: string;
  /** html 段的后处理（如 CodexMarkdown 的裸文档名 linkify）；mermaid 段不经过。 */
  transformHtml?: (html: string) => string;
  /** 对 html 段执行 DOMPurify 消毒。远端内容（如 codeup 审查报告）必须开启；
   *  本地会话消息与原 SessionView / CodexMarkdown 管线一致，默认不消毒。 */
  sanitize?: boolean;
}

const SYNC_MARKDOWN_LIMIT = 10 * 1024;

/**
 * 消息 markdown 分段渲染：html 段整段 dangerouslySetInnerHTML，mermaid 段
 * 挂 React 组件动态渲染 SVG。SessionView / CodexMarkdown / 云效预览共用。
 * 超长文本（>10KB，AGENTS.md 红线：禁止同步 marked 大文本）退化为纯文本。
 */
export function MessageMarkdownBody({ text, className, transformHtml, sanitize }: MessageMarkdownBodyProps) {
  const segments = useMemo(() => {
    if (text.length > SYNC_MARKDOWN_LIMIT) return null;
    try {
      return renderMessageMarkdownSegments(text);
    } catch {
      return null;
    }
  }, [text]);

  if (segments === null) {
    return (
      <div className={className} style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </div>
    );
  }

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.type === "mermaid") {
          return <MermaidBlockWithPreview key={index} code={segment.code} />;
        }
        let html = segment.html;
        if (sanitize) html = DOMPurify.sanitize(html);
        if (transformHtml && html) html = transformHtml(html) ?? html;
        return <div key={index} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </>
  );
}
