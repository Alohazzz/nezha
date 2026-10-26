import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/**
 * structured 任务的常驻底部 composer（Paseo 式会话框的核心形态）：
 * - 任何状态都渲染——运行中提交 = `steer_codex_structured`（turn/steer 追加指令，
 *   当前 turn 不中断）；done 态提交 = `resume_codex_structured`（thread/resume 新 turn）。
 * - Enter 发送 / Shift+Enter 换行；Ctrl+L 聚焦（focus hint 同 Paseo）。
 * - 提交后本地乐观用户气泡由调用方（App 层）负责插入。
 */
export function CodexComposer({
  mode,
  busy,
  disabled,
  onSubmit,
}: {
  /** running = steer 语义（追加进当前 turn）；其余 = resume 语义（新 turn）。 */
  mode: "steer" | "resume";
  busy?: boolean;
  disabled?: boolean;
  onSubmit: (text: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !disabled && !busy && text.trim().length > 0;

  // 自适应高度：输入增长时撑到上限后内部滚动（Paseo composer 同款行为）
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  // Ctrl+L / Cmd+L 聚焦输入框（Paseo 的 message-input.action 同款快捷键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    if (!canSend) return;
    onSubmit(text.trim());
    setText("");
    autoResize();
  };

  const placeholder =
    mode === "steer"
      ? busy
        ? t("codex.composer.steering")
        : t("codex.composer.placeholderRunning")
      : t("codex.composer.placeholderDone");

  return (
    <div style={s.codexComposerWrap}>
      <div style={{ ...s.codexComposerBox, ...(focused ? s.codexComposerBoxFocused : {}) }}>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={disabled || busy}
          style={s.codexComposerInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
            // Enter 发送 / Shift+Enter 换行（与全局 sendShortcut 默认一致）
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div style={s.codexComposerFooter}>
          <span style={s.codexComposerHint}>
            {mode === "steer" ? t("codex.composer.hintSteer") : t("codex.composer.hintResume")}
          </span>
          <span style={s.codexComposerFocusHint}>Ctrl+L</span>
          <button
            type="button"
            disabled={!canSend}
            style={{
              ...s.codexComposerSendBtn,
              ...(!canSend ? s.codexComposerSendBtnDisabled : {}),
            }}
            onClick={submit}
            title={t("codex.followUp.send")}
          >
            <span>{t("codex.followUp.send")}</span>
            <CornerDownLeft size={12} strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </div>
  );
}
