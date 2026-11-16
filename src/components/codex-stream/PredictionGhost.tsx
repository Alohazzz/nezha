import { type KeyboardEvent } from "react";
import { useI18n } from "../../i18n";

/** execCommand performs a native edit: unlike assigning value/setRangeText, it keeps Undo. */
export function acceptPrediction(event: KeyboardEvent<HTMLTextAreaElement>, suggestion: string | null) {
  const input = event.currentTarget;
  if (!suggestion || event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
    || input.disabled || input.value || input.ownerDocument.activeElement !== input) return false;
  if (typeof input.ownerDocument.execCommand !== "function" || !input.ownerDocument.execCommand("insertText", false, suggestion)) return false;
  input.setSelectionRange(input.value.length, input.value.length);
  event.preventDefault();
  return true;
}

export function PredictionGhost({ suggestion, focused, descriptionId }: {
  suggestion: string | null; focused: boolean; descriptionId: string;
}) {
  const { t } = useI18n();
  if (!suggestion) return null;
  return <>
    <span className="codex-prediction-ghost" aria-hidden="true">{suggestion}</span>
    <span id={descriptionId} className="codex-prediction-description">{t("codex.prediction.suggestion")}: {suggestion} — {t("codex.prediction.tab")}</span>
    {focused && <span className="codex-prediction-tab" aria-hidden="true">{t("codex.prediction.tab")}</span>}
  </>;
}
