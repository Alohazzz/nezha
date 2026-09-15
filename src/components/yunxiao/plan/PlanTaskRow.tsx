import { ChevronRight } from "lucide-react";
import type { TaskStatus } from "../../../types";
import { taskStatusI18nKey } from "../../../types";
import type { PlanTaskRow } from "../../../utils/planBoard";
import { StatusIcon } from "../../StatusIcon";
import { useI18n } from "../../../i18n";

/** 任务是否处于「正在干活」（占并发槽、界面突出）。 */
function isRunningStatus(status: TaskStatus): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "input_required" ||
    status === "awaiting_review"
  );
}

/** 终态异常：行左侧标红。 */
function isTerminalBad(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

/** 「12s」/「3m」/「2h」/「1d」——运行或等待时长的紧凑表示。 */
function formatElapsed(from: number | null, now: number): string {
  if (from === null) return "";
  const secs = Math.max(0, Math.floor((now - from) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * 任务行（看板主体，**两行紧凑行**）：
 * - 主行：序号 + 状态图标 + 议题编号 + 标题 + 状态文案，扫一眼看状态。
 * - 副行：前置约束 + 运行时长 + 变更统计 + 失败原因，看关系与代价。
 *
 * 前置约束一律显式列出（「任务之间的约束情况」的落点）。与依赖图联动：`data-hot`
 * 由父级的 `hotSerials` 驱动，图与列表共用同一份高亮状态。
 */
export function PlanTaskRowView({
  row,
  index,
  now,
  hotSerials,
  registerRef,
  onHoverSerial,
  onFocusSerial,
  onOpenTask,
}: {
  row: PlanTaskRow;
  /** 拓扑序里的序号（从 1 起）。 */
  index: number;
  now: number;
  hotSerials: ReadonlySet<string>;
  registerRef: (serial: string, element: HTMLDivElement | null) => void;
  onHoverSerial: (serial: string | null) => void;
  onFocusSerial: (serial: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const { task, status } = row;
  const running = status !== null && isRunningStatus(status);
  const bad = status !== null && isTerminalBad(status);

  const statusLabel =
    status !== null ? t(`status.${taskStatusI18nKey(status)}`) : t("board.noTask");
  const highlightOn = hotSerials.size > 0;
  const hot = highlightOn && hotSerials.has(row.serialNumber);

  const showElapsed =
    status !== null && (running || status === "waiting_deps") && row.statusSince !== null;
  const elapsed = showElapsed ? formatElapsed(row.statusSince, now) : "";

  // 变更统计只在工作区已有改动时显示（worktree diff 落盘在任务上）。
  const hasDiff = task != null && ((task.additions ?? 0) > 0 || (task.deletions ?? 0) > 0);
  const failure = task?.failureReason?.trim() ?? "";

  // 前置约束：异常 / 未满足 / 已满足且有依赖；无依赖不占位。
  const depNode =
    row.dependsOn.length === 0 ? null : row.needsOverride ? (
      <span className="plan-task-dep" data-tone="abnormal">
        {t("board.depAbnormal", { serials: row.unmet.join(", ") })}
      </span>
    ) : row.unmet.length > 0 ? (
      <span className="plan-task-dep" data-tone="blocked">
        {t("board.depWaiting", { serials: row.unmet.join(", ") })}
      </span>
    ) : (
      <span className="plan-task-dep" data-tone="ready">
        {t("board.depReady", { serials: row.dependsOn.join(", ") })}
      </span>
    );

  const hasSubRow = depNode !== null || elapsed !== "" || hasDiff || failure !== "";

  return (
    <div
      ref={(element) => registerRef(row.serialNumber, element)}
      className="plan-task-row"
      data-serial={row.serialNumber}
      data-running={String(running)}
      data-abnormal={String(bad)}
      data-hot={highlightOn ? String(hot) : undefined}
      onMouseEnter={() => onHoverSerial(row.serialNumber)}
      onMouseLeave={() => onHoverSerial(null)}
    >
      <div className="plan-task-row-main">
        <span className="plan-task-index">{index}</span>
        <span className="plan-task-icon">
          <StatusIcon status={status ?? "todo"} />
        </span>
        <span className="plan-task-serial" onClick={() => onFocusSerial(row.serialNumber)}>
          {row.serialNumber}
        </span>
        <span className="plan-task-subject" title={row.subject}>
          {row.subject}
        </span>
        <span
          className="plan-task-status"
          data-tone={bad ? "bad" : running ? "running" : undefined}
        >
          {statusLabel}
        </span>
        {task ? (
          <button
            type="button"
            className="plan-task-open"
            title={t("board.openTask")}
            aria-label={t("board.openTask")}
            onClick={() => onOpenTask(task.id)}
          >
            <ChevronRight size={12} strokeWidth={2} />
          </button>
        ) : null}
      </div>

      {hasSubRow ? (
        <div className="plan-task-row-sub">
          {depNode}
          {elapsed ? (
            <span className="plan-task-meta">{t("board.rowElapsed", { time: elapsed })}</span>
          ) : null}
          {hasDiff ? (
            <>
              <span className="plan-task-diff-add">+{task?.additions ?? 0}</span>
              <span className="plan-task-diff-del">−{task?.deletions ?? 0}</span>
            </>
          ) : null}
          {failure ? (
            <span className="plan-task-fail" title={failure}>
              {failure}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
