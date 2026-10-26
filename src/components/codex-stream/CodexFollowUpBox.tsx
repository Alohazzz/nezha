import { useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/**
 * structured 任务 done 态的继续对话输入框（阶段 4 增强）。
 * 提交后经 App 层调 `resume_codex_structured`（thread/resume + turn/start），
 * 任务回到 running、视图切回流式卡片。失败时 onRejected 回调由调用方 toast。
 */
export function CodexFollowUpBox({
  disabled,
  busy,
  onSubmit,
}: {
  disabled?: boolean;
  busy?: boolean;
  onSubmit: (text: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const canSend = !disabled && !busy && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSubmit(text.trim());
    setText("");
    inputRef.current?.blur();
  };

  return (
    <div style={s.codexFollowUpWrap}>
      <div style={s.codexFollowUpBox} className="codex-stream-followup-box" data-focused={focused || undefined}>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={t("codex.followUp.placeholder")}
          disabled={disabled || busy}
          style={s.codexFollowUpInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter 发送 / Shift+Enter 换行（与全局 sendShortcut 默认一致）
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          disabled={!canSend}
          style={s.codexFollowUpSendBtn}
          onClick={submit}
          title={t("codex.followUp.send")}
        >
          <span>{t("codex.followUp.send")}</span>
          <CornerDownLeft size={12} strokeWidth={2.3} />
        </button>
      </div>
    </div>
  );
}
