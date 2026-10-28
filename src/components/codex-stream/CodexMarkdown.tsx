import { memo, useCallback, useMemo } from "react";
import s from "../../styles";
import { MessageMarkdownBody } from "../mermaid/MessageMarkdownBody";
import { linkifyBareDraftNames } from "./draftDocuments";

// SessionView 的 marked 管线同款（AGENTS.md：单条 >10KB 禁止同步 marked 大文本）。
// 结构化流里单条消息通常远小于该阈值；超过时退回纯文本渲染，不做同步解析。

const SYNC_MARKDOWN_LIMIT = 10 * 1024;

interface MarkdownProps {
  text: string;
  className?: string;
  /** 链接点击委托：非空时接管正文里所有 <a> 的点击（外链走系统浏览器、
   *  沉淀文档在应用内打开、其余目标 toast 说明）。空 = 维持裸链接行为。 */
  onOpenLink?: (href: string) => void;
}

/**
 * 轻量 Markdown 渲染：小文本走 marked 同步分段管线（与 SessionView 一致），
 * mermaid 代码块切段交给 MermaidBlockWithPreview 动态渲染成流程图；
 * 超限文本直接按纯文本展示（流式增长中的文本重解析成本高，且超长 markdown
 * 多为代码块墙，纯文本可读性可接受）。渲染结果按 text memoize。
 *
 * 传 onOpenLink 时，正文里裸写的沉淀文档文件名（discussion.md 等）也会被
 * 转成链接（marked 原样输出这段预置 HTML；HTML 注入面与正文本身一致）。
 */
export const CodexMarkdown = memo(function CodexMarkdown({ text, className, onOpenLink }: MarkdownProps) {
  const overLimit = text.length > SYNC_MARKDOWN_LIMIT;

  const transformHtml = useMemo(() => (onOpenLink ? linkifyBareDraftNames : undefined), [onOpenLink]);
  // transformHtml 可能返回 null（无匹配），dangerouslySetInnerHTML 侧已兜底原样。
  const safeTransformHtml = useCallback(
    (html: string) => transformHtml?.(html) ?? html,
    [transformHtml],
  );

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onOpenLink) return;
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    const href = anchor.getAttribute("href");
    if (!href) return;
    e.preventDefault();
    onOpenLink(href);
  };

  if (overLimit) {
    return (
      <div className={className} style={s.codexMarkdownPlain}>
        {text}
      </div>
    );
  }

  return (
    <div className={className} onClick={handleClick}>
      <MessageMarkdownBody text={text} transformHtml={onOpenLink ? safeTransformHtml : undefined} />
    </div>
  );
});
