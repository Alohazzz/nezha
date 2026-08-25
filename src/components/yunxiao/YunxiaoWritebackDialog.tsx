import { Sparkles, Send, X } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 回写云效预览弹窗：AI 生成「修改方案汇总」→ 可编辑 → 确认发布为议题评论。 */
export function YunxiaoWritebackDialog({
  serialNumber,
  title,
  preview,
  scoreSection,
  generating,
  posting,
  error,
  warning,
  fieldRetrying,
  retryScoreValue,
  posted,
  onPreviewChange,
  onRegenerate,
  onPost,
  onRetryField,
  onClose,
}: {
  serialNumber: string;
  title: string;
  preview: string;
  scoreSection: string | null;
  generating: boolean;
  posting: boolean;
  error: string | null;
  warning: string | null;
  fieldRetrying: boolean;
  retryScoreValue: number | null;
  posted: boolean;
  onPreviewChange: (value: string) => void;
  onRegenerate: () => void;
  onPost: () => void;
  onRetryField: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const canPost = !generating && !posting && !posted && preview.trim().length > 0;
  const canRetryField =
    retryScoreValue != null && !generating && !posting && !fieldRetrying && posted;

  return (
    <div style={s.yunxiaoWritebackBackdrop} onPointerDown={posting ? undefined : onClose}>
      <div
        style={s.yunxiaoWritebackDialog}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div style={s.yunxiaoWritebackTitle}>{t("yunxiao.writeback.dialogTitle")}</div>
        <div style={s.yunxiaoWritebackHint}>
          {title}
          {serialNumber ? ` · ${serialNumber}` : ""}
          {" — "}
          {t("yunxiao.writeback.dialogHint")}
        </div>
        <textarea
          style={s.yunxiaoWritebackTextarea}
          value={preview}
          spellCheck={false}
          placeholder={
            generating
              ? t("yunxiao.writeback.generating")
              : t("yunxiao.writeback.dialogHint")
          }
          disabled={generating}
          onChange={(event) => onPreviewChange(event.target.value)}
        />
        {scoreSection && (
          <div style={s.yunxiaoWritebackScoreBlock}>
            <div style={s.yunxiaoWritebackScoreTitle}>
              {t("yunxiao.writeback.scoreTitle")}
            </div>
            <pre style={s.yunxiaoWritebackScorePre}>{scoreSection}</pre>
          </div>
        )}
        {warning && (
          <div style={s.yunxiaoWritebackError}>
            {warning}
            {canRetryField && (
              <button
                type="button"
                style={s.yunxiaoWritebackRetryBtn}
                onClick={onRetryField}
                disabled={fieldRetrying}
              >
                {fieldRetrying
                  ? t("yunxiao.writeback.fieldRetrying")
                  : t("yunxiao.writeback.retryField", { value: retryScoreValue ?? "" })}
              </button>
            )}
          </div>
        )}
        {error && <div style={s.yunxiaoWritebackError}>{error}</div>}
        <div style={s.yunxiaoWritebackActions}>
          <button
            type="button"
            style={s.yunxiaoWritebackSecondaryBtn}
            onClick={onClose}
            disabled={posting}
            title={t("yunxiao.writeback.cancel")}
          >
            <X size={12} strokeWidth={2.5} />
            {t("yunxiao.writeback.cancel")}
          </button>
          <button
            type="button"
            style={s.yunxiaoWritebackSecondaryBtn}
            onClick={onRegenerate}
            disabled={generating || posting || posted}
            title={t("yunxiao.writeback.regenerate")}
          >
            <Sparkles size={12} strokeWidth={2.5} className={generating ? "spin" : ""} />
            {generating ? t("yunxiao.writeback.generating") : t("yunxiao.writeback.regenerate")}
          </button>
          <button
            type="button"
            style={canPost ? s.yunxiaoWritebackPrimaryBtn : s.yunxiaoWritebackPrimaryBtnDisabled}
            disabled={!canPost}
            onClick={onPost}
          >
            <Send size={12} strokeWidth={2.5} />
            {posting ? t("yunxiao.writeback.posting") : t("yunxiao.writeback.post")}
          </button>
        </div>
      </div>
    </div>
  );
}
