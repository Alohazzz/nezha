import { useMemo, useState } from "react";
import {
  Archive,
  BookOpenText,
  ChevronRight,
  PlayCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Plan, Task, TaskStatus } from "../../../types";
import { taskStatusI18nKey } from "../../../types";
import { buildPlanDisplayName } from "../../../utils/plan";
import {
  derivePlanTaskRows,
  planLifecycleActions,
  type PlanTaskRow,
} from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { StatusIcon } from "../../StatusIcon";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

/** 方案显示名：有自定义名用自定义名，否则由议题编号拼。 */
export function planTitle(plan: Plan): string {
  if (plan.name.trim()) return plan.name;
  return buildPlanDisplayName(plan.issues.map((i) => i.serialNumber));
}

/** 任务是否处于「正在干活」（占并发槽、界面突出）。 */
function isRunningStatus(status: TaskStatus): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "input_required" ||
    status === "awaiting_review"
  );
}

function isTerminalBad(status: TaskStatus): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

/** 「12m」/「3h」/「2d」——运行或等待时长的紧凑表示。 */
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
 * 任务行（看板主体）：状态图标 + 编号 + 标题 + 状态文案 + **前置约束** + 运行时长 + 跳转。
 * 前置约束一律显式列出——这正是「任务之间的约束情况」的落点。
 */
function PlanTaskRowView({
  row,
  now,
  onOpenTask,
}: {
  row: PlanTaskRow;
  now: number;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const status = row.status;
  const running = status !== null && isRunningStatus(status);
  const bad = status !== null && isTerminalBad(status);

  const rowStyle = bad ? s.taskRowAbnormal : running ? s.taskRowRunning : s.taskRow;
  const statusStyle = bad
    ? s.taskRowStatusFailed
    : running
      ? s.taskRowStatusRunning
      : s.taskRowStatus;

  // 状态文案：等待态下若因前置而等，直接用依赖徽章表达，避免「等待前置」重复两次。
  const statusLabel = status !== null ? t(`status.${taskStatusI18nKey(status)}`) : t("board.noTask");

  // 运行 / 等待时长：只在「正在跑」或「等待中」时显示，避免刷屏。
  const showElapsed =
    status !== null && (running || status === "waiting_deps") && row.statusSince !== null;
  const elapsed = showElapsed ? formatElapsed(row.statusSince, now) : "";

  return (
    <div style={rowStyle}>
      <span style={s.taskRowIcon}>
        <StatusIcon status={status ?? "todo"} />
      </span>
      <span style={s.taskRowSerial}>{row.serialNumber}</span>
      <span style={s.taskRowSubject} title={row.subject}>
        {row.subject}
      </span>

      {/* 前置约束：异常 / 未满足 / 已满足且有依赖 */}
      {row.dependsOn.length > 0 &&
        (row.needsOverride ? (
          <span style={s.taskRowDepAbnormal}>
            {t("board.depAbnormal", { serials: row.unmet.join(", ") })}
          </span>
        ) : row.unmet.length > 0 ? (
          <span style={s.taskRowDepBlocked}>
            {t("board.depWaiting", { serials: row.unmet.join(", ") })}
          </span>
        ) : (
          <span style={s.taskRowDepReady}>
            {t("board.depReady", { serials: row.dependsOn.join(", ") })}
          </span>
        ))}

      <span style={statusStyle}>{statusLabel}</span>
      {elapsed ? <span style={s.taskRowRuntime}>{elapsed}</span> : null}

      {row.task ? (
        <button
          type="button"
          style={s.boardIconBtn}
          title={t("board.openTask")}
          aria-label={t("board.openTask")}
          onClick={() => onOpenTask(row.task!.id)}
        >
          <ChevronRight size={13} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 一个方案 = 一个可折叠分组：表头是方案摘要（名称 / 生命周期 / 进度 / 约束 / 动作），
 * 主体是该方案的任务行。方案本身退为分组，重心落在任务上。
 */
export function PlanGroup({
  plan,
  tasks,
  deps,
  expanded,
  onToggleExpand,
  now,
  onPreview,
  onOpenTask,
  onComplete,
  onReopen,
  onCancel,
  onArchive,
  onDelete,
}: {
  plan: Plan;
  tasks: Task[];
  deps?: PlanDeps;
  expanded: boolean;
  onToggleExpand: () => void;
  /** 统一的时间基准，供运行时长计算（避免每行各调 Date.now 造成同帧不一致）。 */
  now: number;
  onPreview: () => void;
  onOpenTask: (taskId: string) => void;
  onComplete: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [hov, setHov] = useState(false);
  const summary = useMemo(() => derivePlanTaskRows(plan, tasks, deps), [plan, tasks, deps]);
  const actions = planLifecycleActions(plan);
  const percent = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
  const title = planTitle(plan);

  return (
    <section
      style={s.planGroup}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      <div
        role="button"
        tabIndex={0}
        style={expanded ? s.planGroupHeader : s.planGroupHeaderCollapsed}
        onClick={onToggleExpand}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        title={title}
        aria-expanded={expanded}
        aria-label={title}
      >
        <ChevronRight
          size={13}
          strokeWidth={2}
          style={expanded ? s.boardChevronExpanded : s.boardChevronCollapsed}
        />
        <span style={s.planGroupName}>{title}</span>
        <span style={s.boardStatusBadge}>{t(`board.column.${plan.status}`)}</span>

        {summary.total > 0 && (
          <span style={s.boardProgressRow}>
            <span style={s.boardProgressTrack}>
              <span className="plan-board-progress-fill" style={{ width: `${percent}%` }} />
            </span>
            <span style={s.boardProgressLabel}>
              {t("board.progress", { done: summary.done, total: summary.total })}
            </span>
          </span>
        )}

        {summary.unmetEdges > 0 ? (
          <span style={s.boardBadgeWaiting}>{t("board.blocked", { count: summary.unmetEdges })}</span>
        ) : null}
        {summary.noTasks ? <span style={s.boardLockedBadge}>{t("board.noTasks")}</span> : null}
        {actions.canComplete && summary.allDone ? (
          <span style={s.boardBadgeReady}>{t("board.readyHint")}</span>
        ) : null}

        <span style={s.planGroupSpacer} />

        {hov && (
          <span style={s.planGroupActions}>
            <button
              type="button"
              style={s.boardMiniBtn}
              onClick={(e) => {
                e.stopPropagation();
                onPreview();
              }}
            >
              <BookOpenText size={11} strokeWidth={2} />
              {t("board.preview")}
            </button>
            {actions.canComplete && (
              <button
                type="button"
                style={s.boardMiniBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onComplete();
                }}
              >
                <PlayCircle size={11} strokeWidth={2} />
                {t("board.complete")}
              </button>
            )}
            {actions.canReopen && (
              <button
                type="button"
                style={s.boardMiniBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onReopen();
                }}
              >
                <RotateCcw size={11} strokeWidth={2} />
                {t("board.reopen")}
              </button>
            )}
            {actions.canArchive && (
              <button
                type="button"
                style={s.boardMiniBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive();
                }}
              >
                <Archive size={11} strokeWidth={2} />
                {t("board.archive")}
              </button>
            )}
            {actions.canCancel && (
              <button
                type="button"
                style={s.boardMiniBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
              >
                <XCircle size={11} strokeWidth={2} />
                {t("board.cancel")}
              </button>
            )}
            <button
              type="button"
              style={s.boardMiniBtnDanger}
              title={t("board.deleteHint")}
              aria-label={t("board.delete")}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
            >
              <Trash2 size={11} strokeWidth={2} />
            </button>
          </span>
        )}
      </div>

      {expanded && (
        <div style={s.taskRows}>
          {summary.rows.length === 0 ? (
            <div style={s.taskRowLast}>
              <span style={s.taskRowSubject}>{t("board.noIssues")}</span>
            </div>
          ) : (
            summary.rows.map((row) => (
              <PlanTaskRowView key={row.workitemId} row={row} now={now} onOpenTask={onOpenTask} />
            ))
          )}
        </div>
      )}
    </section>
  );
}
