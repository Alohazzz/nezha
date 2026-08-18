import { useLayoutEffect, useRef, useState } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import s from "../../styles";
import { useI18n } from "../../i18n";

const VIEWPORT_MARGIN = 8;

/**
 * 评论输入卡片：显示自动识别的 @路径:行号 与代码片段（决策 2 的"选中即定位"正反馈），
 * 用户只写正文，Ctrl+Enter 或点击保存提交。
 */
export function CommentComposer({
  location,
  snippet,
  x,
  y,
  onSubmit,
  onCancel,
}: {
  location: string;
  snippet?: string;
  x?: number;
  y?: number;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // 首帧按原始坐标渲染但隐藏，量出真实尺寸后钳制到视口内再显示（同 tabMenu 模式）。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(x ?? VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN),
    );
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(y ?? VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN),
    );
    setPos({ left, top });
  }, [x, y]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const value = text.trim();
      if (value) onSubmit(value);
    }
  };

  return (
    <div
      ref={ref}
      style={{
        ...s.rcComposer,
        left: pos?.left ?? x ?? VIEWPORT_MARGIN,
        top: pos?.top ?? y ?? VIEWPORT_MARGIN,
        visibility: pos ? "visible" : "hidden",
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div style={s.rcComposerLoc} title={location}>
        {location}
      </div>
      {snippet ? (
        <pre style={s.rcComposerSnippet}>{snippet}</pre>
      ) : null}
      <textarea
        style={s.rcComposerTextarea}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t("reviewComments.placeholder")}
        autoFocus
      />
      <div style={s.rcComposerActions}>
        <button
          type="button"
          style={s.rcComposerBtn}
          onClick={onCancel}
          title={t("reviewComments.cancel")}
        >
          <X size={12} />
          {t("reviewComments.cancel")}
        </button>
        <button
          type="button"
          style={s.rcComposerBtnPrimary}
          disabled={!text.trim()}
          onClick={() => onSubmit(text.trim())}
          title={t("reviewComments.save")}
        >
          <MessageSquarePlus size={12} />
          {t("reviewComments.save")}
        </button>
      </div>
    </div>
  );
}
