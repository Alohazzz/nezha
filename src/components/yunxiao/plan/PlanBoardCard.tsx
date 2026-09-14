import { useMemo, useState, type CSSProperties } from "react";
import {
  Archive,
  BookOpenText,
  ChevronDown,
  ChevronRight,
  PlayCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Plan, Task } from "../../../types";
import { buildPlanDisplayName } from "../../../utils/plan";
import {
  derivePlanProgress,
  planLifecycleActions,
  type PlanIssueProgress,
} from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { StatusIcon } from "../../StatusIcon";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

export function planTitle(plan: Plan): string {
  if (plan.name.trim()) return plan.name;
  return buildPlanDisplayName(plan.issues.map((issue) => issue.serialNumber));
}

/** 任务状态 → i18n key 后缀（与 TaskListItem 保持一致的最小映射）。 */
function statusKey(status: NonNullable<PlanIssueProgress["status"]>): string {
  switch (status) {
    case "todo":
      return "todo";
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "input_required":
      return "inputRequired";
    case "awaiting_review":
      return "awaitingReview";
    case "detached":
      return "detached";
    case "interrupted":
      return "interrupted";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/** 议题 chip 的状态样式：done 绿 / 失败红 / 有未满足前置 黄 / 其他灰。 */
function serialChipStyle(issue: PlanIssueProgress): CSSProperties {
  if (issue.done) return s.boardSerialChipDone;
  if (issue.status === "failed" || issue.status === "cancelled" || issue.status === "interrupted") {
    return s.boardSerialChipFailed;
  }
  if (issue.unmet.length > 0) return s.boardSerialChipBlocked;
  return s.boardSerialChip;
}

function PlanIssueRow({
  issue,
  onOpenTask,
}: {
  issue: PlanIssueProgress;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useI18n();
  const failed =
    issue.status === "failed" || issue.status === "cancelled" || issue.status === "interrupted";
  return (
    <div style={s.boardIssueRow}>
      <span style={s.boardIssueSerial}>{issue.serialNumber}</span>
      <span style={s.boardIssueSubject} title={issue.subject}>
        {issue.subject}
      </span>
      {issue.unmet.length > 0 ? (
        <span style={s.boardIssueDeps}>
          {t("board.issueBlockedBy", { serials: issue.unmet.join(", ") })}
        </span>
      ) : null}
      {issue.status === null ? (
        <span style={s.boardIssueStatus}>{t("board.taskMissing")}</span>
      ) : (
        <span style={failed ? s.boardIssueStatusFailed : s.boardIssueStatus}>
          {t(`status.${statusKey(issue.status)}`)}
        </span>
      )}
      <span style={s.boardIconSlot}>
        <StatusIcon status={issue.status ?? "todo"} />
      </span>
      {issue.taskId ? (
        <button
          type="button"
          style={s.boardIconBtn}
          title={t("board.openTask")}
          aria-label={t("board.openTask")}
          onClick={() => onOpenTask(issue.taskId as string)}
        >
          <ChevronRight size={13} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}

/** 方案卡片：方案名 / 进度条 / 议题 chips / 依赖摘要 / 可展开议题行 / hover 动作。 */
export function PlanBoardCard({
  plan,
  tasks,
  deps,
  expanded,
  onToggleExpand,
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
  const progress = useMemo(() => derivePlanProgress(plan, tasks, deps), [plan, tasks, deps]);
  const actions = planLifecycleActions(plan);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      style={hov ? s.boardCardHover : s.boardCard}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      onClick={onToggleExpand}
      title={planTitle(plan)}
    >
      <div style={s.boardCardHead}>
        <span style={s.boardCardName}>{planTitle(plan)}</span>
        <button
          type="button"
          style={s.boardIconBtn}
          aria-label={expanded ? t("board.collapse") : t("board.expand")}
          title={expanded ? t("board.collapse") : t("board.expand")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand();
          }}
        >
          <ChevronDown
            size={13}
            strokeWidth={2}
            style={expanded ? undefined : { transform: "rotate(-90deg)" }}
          />
        </button>
      </div>

      {progress.total > 0 && (
        <div style={s.boardProgressRow}>
          <span style={s.boardProgressTrack}>
            <span
              className="plan-board-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </span>
          <span style={s.boardProgressLabel}>
            {t("board.progress", { done: progress.done, total: progress.total })}
          </span>
        </div>
      )}

      <div style={s.boardCardSerials}>
        {progress.issues.map((issue) => (
          <span key={issue.workitemId} style={serialChipStyle(issue)}>
            {issue.serialNumber}
          </span>
        ))}
      </div>

      <div style={s.boardSummaryRow}>
        {progress.unmetEdges > 0 ? (
          <span style={s.boardBadgeWaiting}>{t("board.blocked", { count: progress.unmetEdges })}</span>
        ) : null}
        {progress.noTasks ? <span style={s.boardLockedBadge}>{t("board.noTasks")}</span> : null}
        {progress.allDone && plan.status !== "completed" ? (
          <span style={s.boardBadgeReady}>{t("board.readyHint")}</span>
        ) : null}
        {plan.batchId ? <span style={s.boardLockedBadge}>{t("plan.preview.batchLinked")}</span> : null}
      </div>

      {expanded && (
        <div style={s.boardIssueList}>
          {progress.issues.map((issue) => (
            <PlanIssueRow key={issue.workitemId} issue={issue} onOpenTask={onOpenTask} />
          ))}
        </div>
      )}

      {hov && (
        <div style={s.boardCardActions}>
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
        </div>
      )}
    </div>
  );
}
