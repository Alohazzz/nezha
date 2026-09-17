import { Layers, X, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { useI18n } from "../../i18n";
import type { KnowledgeSedimentationEvent } from "../../types";
import s from "../../styles";

/**
 * 只读的「本次沉淀结果」：任务完成后自动沉淀的结果查看。
 *
 * 自动沉淀已改为任务完成即处理（无需手动触发），因此这里**没有**操作能力——
 * 只展示写了哪些条目、拒了哪些以及逐条判定理由，供追溯与排查。
 */
export function KnowledgeSedimentationResultDialog({
  result,
  onClose,
}: {
  result: KnowledgeSedimentationEvent;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const items = result.items ?? [];
  const written = items.filter((item) => item.written).length;
  const rejected = items.filter((item) => !item.passed).length;

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.knowledgeDialogBox} onClick={(event) => event.stopPropagation()}>
        <div style={s.knowledgeDialogHeader}>
          <Layers size={16} strokeWidth={2.2} />
          <div style={s.knowledgeDialogHeaderMain}>
            <div style={s.knowledgeDialogTitle}>{t("yunxiao.knowledge.resultTitle")}</div>
            <div style={s.knowledgeDialogSubtitle}>
              {result.status === "failed"
                ? t("yunxiao.knowledge.resultFailed")
                : t("yunxiao.knowledge.resultCounts", {
                    written: String(written),
                    rejected: String(rejected),
                  })}
            </div>
          </div>
          <button type="button" style={s.knowledgeSecondaryBtn} onClick={onClose}>
            <X size={14} strokeWidth={2.4} />
          </button>
        </div>

        <div style={s.knowledgeDialogBody}>
          {result.status === "failed" ? (
            <div style={s.knowledgeError}>
              <AlertCircle size={14} strokeWidth={2.4} />
              <span>{result.error ?? t("yunxiao.knowledge.resultFailedHint")}</span>
            </div>
          ) : items.length === 0 ? (
            <div style={s.knowledgeHint}>{t("yunxiao.knowledge.resultEmpty")}</div>
          ) : (
            <div style={s.knowledgeList}>
              {items.map((item) => (
                <div key={item.index} style={s.knowledgeCard}>
                  <div style={s.knowledgeCardHeader}>
                    {item.written ? (
                      <CheckCircle2 size={13} strokeWidth={2.5} color="var(--success)" />
                    ) : (
                      <XCircle size={13} strokeWidth={2.5} color="var(--danger)" />
                    )}
                    <span style={s.knowledgeModule}>{item.module}</span>
                    <span style={s.knowledgeSection}>{item.section}</span>
                    <span style={s.knowledgeSection}>{item.layer}</span>
                  </div>
                  <div style={s.knowledgeHint}>{item.reason}</div>
                </div>
              ))}
            </div>
          )}

          {result.status === "ok" && result.pushedPending ? (
            <div style={s.knowledgeHint}>{t("yunxiao.knowledge.resultPushedPending")}</div>
          ) : null}
        </div>

        <div style={s.knowledgeDialogFooter}>
          <button type="button" style={s.knowledgeSecondaryBtn} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
