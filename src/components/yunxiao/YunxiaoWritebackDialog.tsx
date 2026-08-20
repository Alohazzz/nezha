import { Sparkles, Send, X } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 回写云效预览弹窗：AI 生成「修改方案汇总」→ 可编辑 → 确认发布为议题评论。 */
export function YunxiaoWritebackDialog({
  serialNumber,
  title,
  preview,
  generating,
  posting,
  error,
  onPreviewChange,
  onRegenerate,
  onPost,
  onClose,
}: {
  serialNumber: string;
  title: string;
  preview: string;
  generating: boolean;
  posting: boolean;
  error: string | null;
  onPreviewChange: (value: string) => void;
  onRegenerate: () => void;
  onPost: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const canPost = !generating && !posting && preview.trim().length > 0;

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
            disabled={generating || posting}
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
