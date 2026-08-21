import { Layers, RefreshCw, Send, X, AlertCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { KnowledgeSuggestion } from "../../types";
import s from "../../styles";

/** 知识沉淀预览弹窗：headless 提取候选 → 逐条编辑/勾选 → 批量创建云效审核议题。 */
export function KnowledgeSedimentationDialog({
  serialNumber,
  title,
  suggestions,
  generating,
  creating,
  error,
  selected,
  onToggle,
  onSuggestionChange,
  onRegenerate,
  onCreate,
  onClose,
}: {
  serialNumber: string;
  title: string;
  suggestions: KnowledgeSuggestion[];
  generating: boolean;
  creating: boolean;
  error: string | null;
  selected: Set<number>;
  onToggle: (index: number) => void;
  onSuggestionChange: (index: number, patch: Partial<KnowledgeSuggestion>) => void;
  onRegenerate: () => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const canCreate = !generating && !creating && selected.size > 0;

  return (
    <div style={s.modalOverlay} onClick={creating ? undefined : onClose}>
      <div
        style={s.knowledgeDialogBox}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={s.knowledgeDialogHeader}>
          <div style={s.knowledgeDialogHeaderMain}>
            <div style={s.knowledgeDialogTitle}>
              <Layers size={15} strokeWidth={2} />
              <span>{t("yunxiao.knowledge.dialogTitle")}</span>
            </div>
            <div style={s.knowledgeDialogSubtitle}>
              {title}
              {serialNumber ? ` · ${serialNumber}` : ""}
            </div>
          </div>
          <button type="button" style={s.modalCloseBtn} onClick={onClose} disabled={creating}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div style={s.knowledgeDialogBody}>
          {generating ? (
            <div style={s.knowledgeHint}>{t("yunxiao.knowledge.generating")}</div>
          ) : suggestions.length === 0 ? (
            <div style={s.knowledgeHint}>{t("yunxiao.knowledge.emptyResult")}</div>
          ) : (
            <div style={s.knowledgeList}>
              {suggestions.map((suggestion, index) => {
                const checked = selected.has(index);
                return (
                  <div
                    key={index}
                    style={checked ? s.knowledgeCardChecked : s.knowledgeCard}
                  >
                    <div style={s.knowledgeCardHeader}>
                      <label style={s.knowledgeCheckboxLabel}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => onToggle(index)}
                          disabled={creating}
                        />
                      </label>
                      <span style={s.knowledgeModule}>{suggestion.module}</span>
                      <span style={s.knowledgeSection}>{suggestion.section}</span>
                      <span
                        style={
                          suggestion.confidence === "confirmed"
                            ? s.knowledgeConfidenceConfirmed
                            : s.knowledgeConfidencePending
                        }
                      >
                        {suggestion.confidence === "confirmed"
                          ? t("yunxiao.knowledge.confirmed")
                          : t("yunxiao.knowledge.pending")}
                      </span>
                    </div>
                    <div style={s.knowledgeField}>
                      <label style={s.knowledgeLabel}>
                        {t("yunxiao.knowledge.suggestedTitle")}
                      </label>
                      <input
                        style={s.knowledgeInput}
                        value={suggestion.suggestedTitle}
                        onChange={(event) =>
                          onSuggestionChange(index, {
                            suggestedTitle: event.target.value,
                          })
                        }
                        disabled={creating}
                      />
                    </div>
                    <div style={s.knowledgeField}>
                      <label style={s.knowledgeLabel}>{t("yunxiao.knowledge.content")}</label>
                      <textarea
                        style={s.knowledgeTextarea}
                        value={suggestion.content}
                        onChange={(event) =>
                          onSuggestionChange(index, { content: event.target.value })
                        }
                        disabled={creating}
                        spellCheck={false}
                      />
                    </div>
                    <div style={s.knowledgeField}>
                      <label style={s.knowledgeLabel}>{t("yunxiao.knowledge.evidence")}</label>
                      <input
                        style={s.knowledgeInput}
                        value={suggestion.evidence}
                        onChange={(event) =>
                          onSuggestionChange(index, { evidence: event.target.value })
                        }
                        disabled={creating}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {error ? (
            <div style={s.knowledgeError}>
              <AlertCircle size={14} strokeWidth={2} />
              <span>{error}</span>
            </div>
          ) : null}
        </div>

        <div style={s.knowledgeDialogFooter}>
          <button
            type="button"
            style={s.modalCancelBtn}
            onClick={onClose}
            disabled={creating}
          >
            {t("yunxiao.writeback.cancel")}
          </button>
          <button
            type="button"
            style={s.knowledgeSecondaryBtn}
            onClick={onRegenerate}
            disabled={generating || creating}
          >
            <RefreshCw size={12} strokeWidth={2.5} className={generating ? "spin" : ""} />
            {generating ? t("yunxiao.knowledge.generating") : t("yunxiao.knowledge.regenerate")}
          </button>
          <button
            type="button"
            style={canCreate ? s.knowledgePrimaryBtn : s.knowledgePrimaryBtnDisabled}
            onClick={onCreate}
            disabled={!canCreate}
          >
            <Send size={12} strokeWidth={2.5} />
            {creating
              ? t("yunxiao.knowledge.creating")
              : t("yunxiao.knowledge.createSelected", { count: selected.size })}
          </button>
        </div>
      </div>
    </div>
  );
}
