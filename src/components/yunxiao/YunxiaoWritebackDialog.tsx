import { Sparkles, Send, X } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 回写云效预览弹窗：AI 生成「开发向 + 测试向」两条评论 → 分别可编辑 → 一次性发布。 */
export function YunxiaoWritebackDialog({
  serialNumber,
  title,
  devPreview,
  testPreview,
  generating,
  posting,
  error,
  warning,
  fieldRetrying,
  retryScoreValue,
  posted,
  onDevChange,
  onTestChange,
  onRegenerate,
  onPost,
  onRetryField,
  onClose,
}: {
  serialNumber: string;
  title: string;
  devPreview: string;
  testPreview: string;
  generating: boolean;
  posting: boolean;
  error: string | null;
  warning: string | null;
  fieldRetrying: boolean;
  retryScoreValue: number | null;
  posted: boolean;
  onDevChange: (value: string) => void;
  onTestChange: (value: string) => void;
  onRegenerate: () => void;
  onPost: () => void;
  onRetryField: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const canPost = !generating && !posting && !posted && devPreview.trim().length > 0;
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

        <div style={s.yunxiaoWritebackFieldLabel}>{t("yunxiao.writeback.devLabel")}</div>
        <textarea
          style={s.yunxiaoWritebackTextarea}
          value={devPreview}
          spellCheck={false}
          placeholder={
            generating
              ? t("yunxiao.writeback.generatingDev")
              : t("yunxiao.writeback.devPlaceholder")
          }
          disabled={generating}
          onChange={(event) => onDevChange(event.target.value)}
        />

        <div style={s.yunxiaoWritebackFieldLabel}>{t("yunxiao.writeback.testLabel")}</div>
        <textarea
          style={s.yunxiaoWritebackTextarea}
          value={testPreview}
          spellCheck={false}
          placeholder={
            generating
              ? t("yunxiao.writeback.generatingTest")
              : t("yunxiao.writeback.testPlaceholder")
          }
          disabled={generating}
          onChange={(event) => onTestChange(event.target.value)}
        />

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
