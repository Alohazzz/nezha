import { memo, useEffect, useRef, useState } from "react";

// ── 思考摘要行（对标 ZCode ReasoningTrigger）─────────────────────────────────
// 思考正文不再自动展开，摘要行直接承载思考文本：
// - 流式态：取「最新一行非空内容」单行展示；文本超出可用宽度后把视口推到
//   末尾并双侧渐隐——最新 token 永远可见，旧内容向左溢出，形成跑马灯效果。
// - 完成态：退回静态单行省略号（由调用方给截断后的摘要首行）。
//
// 性能：observer 只随 live 挂载一次；逐帧变化只做 scrollLeft / overflow 边沿
// 比较（溢出状态不变就不 setState），不会因为每个 delta 重建 observer。

/** 取流式思考文本的最后一行非空内容（ZCode resolveReasoningStreamingSummary 同款）。 */
export function resolveLatestThoughtLine(text: string): string {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line) return line;
  }
  return "";
}

export const CodexThoughtLine = memo(function CodexThoughtLine({
  text,
  live,
}: {
  text: string;
  /** true = 流式态（跟随尾部滚动）；false = 完成态（静态省略号）。 */
  live: boolean;
}) {
  const viewportRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  // 尺寸变化（容器换宽 / 字体变化）也要重新判定溢出
  useEffect(() => {
    if (!live) return;
    const viewport = viewportRef.current;
    const content = textRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const next = content.scrollWidth > viewport.clientWidth + 1;
      setOverflowing((current) => (current === next ? current : next));
      viewport.scrollLeft = viewport.scrollWidth;
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [live]);

  // 内容增长：把单行视口推到末尾。普通 overflow-hidden 会固定显示旧前缀，
  // 最新 token 被裁在右侧；推到末尾后旧内容向左移出，形成跟播。
  useEffect(() => {
    if (!live) return;
    const viewport = viewportRef.current;
    const content = textRef.current;
    if (!viewport || !content) return;
    const next = content.scrollWidth > viewport.clientWidth + 1;
    setOverflowing((current) => (current === next ? current : next));
    viewport.scrollLeft = viewport.scrollWidth;
  }, [live, text]);

  if (!live) {
    return (
      <span className="codex-stream-thought-line" data-testid="codex-reasoning-summary">
        {text}
      </span>
    );
  }

  return (
    <span
      ref={viewportRef}
      className="codex-stream-thought-line"
      data-live="true"
      data-overflowing={overflowing || undefined}
      data-testid="codex-reasoning-summary"
    >
      <span ref={textRef} className="codex-stream-thought-line-text">
        {text}
      </span>
    </span>
  );
});
