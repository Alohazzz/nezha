import { useCallback } from "react";
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  Hourglass,
  Loader2,
  PlayCircle,
  XCircle,
} from "lucide-react";
import type { Plan, PlanIssue, Task } from "../../../types";
import { taskStatusI18nKey } from "../../../types";
import type { PlanDepEntry, PlanWaitReason } from "../../../utils/planQueue";
import { planTitle } from "../../../utils/plan";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

/**
 * 等待前置任务的详情视图：**先讲清在等什么**（三种原因信息量完全不同），再给动作。
 *
 * - `deps`：完整 Checklist（前置议题编号 + 标题 + 当前状态，可点击跳转）；
 * - `slot`：前置已满足，排队等并发槽位——列出正在占槽的任务（可跳转），让「等」有对象；
 * - `loading`：deps.json 尚未解析进缓存（重启首拍）——说明是状态未就绪而非真的在排队。
 *
 * 底部提供「取消等待」；存在异常 / 缺失前置时额外给「忽略依赖，仍然开始」。
 *
 * 追加子方案（阶段三）的 Checklist 可能含**上游方案**的议题（跨方案前置）；这类条目
 * 用 `depPeerPlans` 标注所属方案——用户要决定「敢不敢忽略」，就得知道等的是本方案
 * 的下一步还是主方案里某个议题。
 */
export function WaitingDepsView({
  task,
  plan,
  reason,
  entries,
  subjects,
  depPeerPlans,
  activeTasks,
  onJump,
  onCancelWait,
  onIgnoreRun,
}: {
  task: Task;
  plan: Plan | null;
  /** 等待原因（由 resolveWaitReason 派生，不在这里重算）。 */
  reason: PlanWaitReason;
  entries: PlanDepEntry[];
  subjects: Map<string, PlanIssue>;
  /** 跨方案前置：编号 → 所属（祖先）方案名；本方案内的前置不在其中。 */
  depPeerPlans: Map<string, string>;
  /** 占槽任务（reason = slot 时的「谁在跑」，可跳转）。 */
  activeTasks: Task[];
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

  const title =
    reason === "deps"
      ? t("plan.deps.checklistTitle")
      : reason === "slot"
        ? t("plan.deps.queueTitle")
        : t("plan.deps.loadingTitle");
  const hint =
    reason === "deps"
      ? t("plan.deps.checklistHint")
      : reason === "slot"
        ? t("plan.deps.queuedHint")
        : t("plan.deps.loadingHint");

  return (
    <div style={s.yunxiaoDetailPane}>
      <div style={s.yunxiaoHeader}>
        <div>
          <div style={s.yunxiaoHeaderTitle}>{task.name ?? t("plan.task.title")}</div>
          <div style={s.yunxiaoHeaderMeta}>
            {task.yunxiaoSerialNumber ? `${task.yunxiaoSerialNumber} · ` : ""}
            {plan ? planTitle(plan) : t("status.waitingDeps")}
          </div>
        </div>
      </div>

      <div style={s.yunxiaoDetailBody}>
        <section style={s.yunxiaoDetailSection}>
          <div style={s.yunxiaoDetailSectionTitle}>{title}</div>
          <div style={s.depsHint}>{hint}</div>

          {reason === "deps" && (
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
                      {depPeerPlans.has(entry.serialNumber) ? (
                        <span style={s.depsEntryPeer}>
                          {t("plan.deps.entryPeer", {
                            plan: depPeerPlans.get(entry.serialNumber) ?? "",
                          })}
                        </span>
                      ) : null}
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
          )}

          {reason === "slot" && activeTasks.length > 0 && (
            <div style={s.depsList}>
              {activeTasks.map((occupant) => (
                <div key={occupant.id} style={s.depsEntry}>
                  <span style={s.depsEntryIcon}>
                    <Hourglass size={14} strokeWidth={2} color="var(--text-hint)" />
                  </span>
                  <div style={s.depsEntryBody}>
                    <span style={s.depsEntrySubject}>
                      {occupant.name ?? occupant.id}
                    </span>
                  </div>
                  <span style={s.depsEntryStatus}>
                    {t(`status.${taskStatusI18nKey(occupant.status)}`)}
                  </span>
                  <button
                    type="button"
                    style={s.depsEntryJump}
                    title={t("common.preview")}
                    aria-label={t("common.preview")}
                    onClick={() => onJump(occupant.id)}
                  >
                    <ChevronRight size={14} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {reason === "loading" && (
            <div style={s.depsList}>
              <div style={s.depsEntry}>
                <span style={s.depsEntryIcon}>
                  <Loader2 size={14} strokeWidth={2} className="spin" />
                </span>
                <div style={s.depsEntryBody}>
                  <span style={s.depsEntrySubject}>{t("plan.deps.loadingTitle")}</span>
                </div>
              </div>
            </div>
          )}

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
