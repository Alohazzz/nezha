import { useMemo } from "react";
import s from "../../styles";
import { renderMessageMarkdown } from "../../utils/markdown";

// SessionView 的 marked 管线同款（AGENTS.md：单条 >10KB 禁止同步 marked 大文本）。
// 结构化流里单条消息通常远小于该阈值；超过时退回纯文本渲染，不做同步解析。

const SYNC_MARKDOWN_LIMIT = 10 * 1024;

interface MarkdownProps {
  text: string;
  className?: string;
}

/**
 * 轻量 Markdown 渲染：小文本走 marked 同步管线（与 SessionView 一致），
 * 超限文本直接按纯文本展示（流式增长中的文本重解析成本高，且超长 markdown
 * 多为代码块墙，纯文本可读性可接受）。渲染结果按 text memoize。
 */
export function CodexMarkdown({ text, className }: MarkdownProps) {
  const html = useMemo(() => {
    if (text.length > SYNC_MARKDOWN_LIMIT) return null;
    try {
      return renderMessageMarkdown(text);
    } catch {
      return null;
    }
  }, [text]);

  if (html === null) {
    return (
      <div className={className} style={s.codexMarkdownPlain}>
        {text}
      </div>
    );
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
