import { useCallback } from "react";
import { CheckCircle2, Circle, ChevronRight, Hourglass, PlayCircle, XCircle } from "lucide-react";
import type { Plan, PlanIssue, Task } from "../../../types";
import type { PlanDepEntry } from "../../../utils/planQueue";
import { buildPlanDisplayName } from "../../../utils/plan";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

/**
 * 等待前置任务的详情视图：完整 Checklist（前置议题编号 + 标题 + 当前状态，可点击跳转），
 * 底部提供「取消等待」；存在异常 / 缺失前置时额外给「忽略依赖，仍然开始」。
 */
export function WaitingDepsView({
  task,
  plan,
  entries,
  subjects,
  onJump,
  onCancelWait,
  onIgnoreRun,
}: {
  task: Task;
  plan: Plan | null;
  entries: PlanDepEntry[];
  subjects: Map<string, PlanIssue>;
  onJump: (taskId: string) => void;
  onCancelWait: (taskId: string) => void;
  onIgnoreRun: (taskId: string) => void;
}) {
  const { t } = useI18n();

  const needsOverride = entries.some(
    (entry) => entry.blocker === "abnormal" || entry.blocker === "missing",
  );

  const handleIgnore = useCallback(() => onIgnoreRun(task.id), [onIgnoreRun, task.id]);
  const handleCancel = useCallback(() => onCancelWait(task.id), [onCancelWait, task.id]);

  return (
    <div style={s.yunxiaoDetailPane}>
      <div style={s.yunxiaoHeader}>
        <div>
          <div style={s.yunxiaoHeaderTitle}>{task.name ?? t("plan.task.title")}</div>
          <div style={s.yunxiaoHeaderMeta}>
            {task.yunxiaoSerialNumber ? `${task.yunxiaoSerialNumber} · ` : ""}
            {plan
              ? plan.name || buildPlanDisplayName(plan.issues.map((issue) => issue.serialNumber))
              : t("status.waitingDeps")}
          </div>
        </div>
      </div>

      <div style={s.yunxiaoDetailBody}>
        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>
            {entries.length === 0 ? t("plan.deps.queueTitle") : t("plan.deps.checklistTitle")}
          </div>
          <div style={s.depsHint}>
            {entries.length === 0 ? t("plan.deps.queuedHint") : t("plan.deps.checklistHint")}
          </div>
          <div style={s.depsList}>
            {entries.map((entry) => {
              const subject = subjects.get(entry.serialNumber);
              const done = entry.blocker === null;
              const abnormal = entry.blocker === "abnormal" || entry.blocker === "missing";
              const rowStyle = done
                ? s.depsEntryDone
                : abnormal
                  ? s.depsEntryAbnormal
                  : s.depsEntry;
              const statusLabel = done
                ? t("plan.deps.entryDone")
                : entry.blocker === "missing"
                  ? t("plan.deps.entryMissing")
                  : entry.blocker === "abnormal"
                    ? t("plan.deps.entryAbnormal")
                    : t("plan.deps.entryWaiting");
              return (
                <div key={entry.serialNumber} style={rowStyle}>
                  <span style={s.depsEntryIcon}>
                    {done ? (
                      <CheckCircle2 size={14} strokeWidth={2} color="var(--success)" />
                    ) : abnormal ? (
                      <XCircle size={14} strokeWidth={2} color="var(--danger)" />
                    ) : (
                      <Circle size={14} strokeWidth={2} color="var(--text-hint)" />
                    )}
                  </span>
                  <div style={s.depsEntryBody}>
                    <span style={s.depsEntrySerial}>{entry.serialNumber}</span>
                    {subject ? <span style={s.depsEntrySubject}>{subject.subject}</span> : null}
                  </div>
                  <span style={abnormal ? s.depsEntryStatusAbnormal : s.depsEntryStatus}>
                    {statusLabel}
                  </span>
                  {entry.taskId ? (
                    <button
                      type="button"
                      style={s.depsEntryJump}
                      title={t("common.preview")}
                      aria-label={t("common.preview")}
                      onClick={() => onJump(entry.taskId as string)}
                    >
                      <ChevronRight size={14} strokeWidth={2} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>

          {needsOverride ? <div style={s.depsOverrideNote}>{t("plan.deps.needOverride")}</div> : null}

          <div style={s.depsActions}>
            <button type="button" style={s.knowledgeSecondaryBtn} onClick={handleCancel}>
              <XCircle size={12} strokeWidth={2} />
              {t("plan.deps.cancelWait")}
            </button>
            {needsOverride ? (
              <button type="button" style={s.yunxiaoPrimaryBtn} onClick={handleIgnore}>
                <PlayCircle size={12} strokeWidth={2} />
                {t("plan.deps.ignoreAndRun")}
              </button>
            ) : (
              <span style={s.depsEditNone}>
                <Hourglass size={12} strokeWidth={2} /> {t("status.waitingDeps")}
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
