import { useState, memo } from "react";
import { Trash2, Star, Play, GitBranch, Hourglass } from "lucide-react";
import { taskStatusI18nKey, type Task } from "../../types";
import { StatusIcon } from "../StatusIcon";
import { useI18n } from "../../i18n";
import s from "../../styles";
import claudeLogo from "../../assets/claude.svg";
import chatgptLogo from "../../assets/chatgpt.svg";

export const TaskListItem = memo(
  function TaskListItem({
    task,
    selected,
    onClick,
    onDelete,
    onToggleStar,
    onRunTodo,
    waitingBadgeKind,
    waitingBadgeCount,
    waitingBadgeBlocked,
  }: {
    task: Task;
    selected: boolean;
    onClick: () => void;
    onDelete: () => void;
    onToggleStar: () => void;
    onRunTodo?: () => void;
    /** 等待前置角标：deps = 等前置，slot = 前置已满足、排队等并发槽位。 */
    waitingBadgeKind?: "deps" | "slot";
    waitingBadgeCount?: number;
    /** 存在异常/缺失前置（角标标红）。 */
    waitingBadgeBlocked?: boolean;
  }) {
    const { t } = useI18n();
    const [hov, setHov] = useState(false);
    const displayTitle = task.name ?? task.prompt;
    return (
      <div
        style={{
          ...s.taskCard,
          position: "relative",
          background: selected ? "var(--bg-selected)" : hov ? "var(--bg-hover)" : "transparent",
        }}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        onClick={onClick}
      >
        <div style={{ flexShrink: 0, marginTop: 1 }}>
          <StatusIcon status={task.status} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={s.taskCardTitle}>
            {displayTitle.slice(0, 70)}
            {displayTitle.length > 70 ? "…" : ""}
          </div>
          <div style={s.taskCardSub}>
            {t(`status.${taskStatusI18nKey(task.status)}`)}
            {waitingBadgeKind && (
              <span style={waitingBadgeBlocked ? s.taskWaitingBadgeBlocked : s.taskWaitingBadge}>
                <Hourglass size={10} strokeWidth={2.2} />
                {waitingBadgeKind === "slot"
                  ? t("plan.deps.waitingSlotBadge")
                  : t("plan.deps.waitingBadge", { count: waitingBadgeCount ?? 0 })}
              </span>
            )}
            {task.status === "done" &&
              task.yunxiaoWorkitemId &&
              !task.yunxiaoWrittenBackAt && (
                <span style={s.yunxiaoWritebackBadge}>
                  {t("yunxiao.writeback.badgePending")}
                </span>
              )}
            {task.status === "done" &&
              task.worktreePath &&
              task.baseBranch &&
              task.additions !== undefined &&
              task.deletions !== undefined && (
                <span style={s.taskDiffStats}>
                  <span style={s.taskDiffAdditions}>+{task.additions}</span>
                  <span style={s.taskDiffDeletions}>−{task.deletions}</span>
                </span>
              )}
          </div>
        </div>
        {task.agent === "dsh" ? (
          <span
            title="DSH"
            style={{
              ...s.agentBadge,
              position: "absolute",
              right: 16,
              top: 11,
              opacity: hov ? 0 : 1,
              pointerEvents: "none",
              transition: "opacity 0.12s ease",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 9,
              fontWeight: 700,
              color: "var(--text-muted)",
            }}
          >
            DSH
          </span>
        ) : (
          <img
            src={task.agent === "claude" ? claudeLogo : chatgptLogo}
            title={task.agent === "claude" ? "Claude Code" : "Codex"}
            style={{
              ...s.agentBadge,
              position: "absolute",
              right: 16,
              top: 11,
              opacity: hov ? 0 : 1,
              filter: task.agent === "codex" ? "var(--agent-badge-filter)" : "none",
              pointerEvents: "none",
              transition: "opacity 0.12s ease",
              zIndex: 1,
            }}
          />
        )}
        {task.worktreePath && task.worktreeBranch && (
          <span
            title={t("task.worktreeBadge", { branch: task.worktreeBranch })}
            style={{ ...s.worktreeBadge, opacity: hov ? 0 : 1 }}
          >
            <GitBranch size={11} strokeWidth={2.2} />
          </span>
        )}
        <button
          type="button"
          aria-label={task.starred ? t("task.unstar") : t("task.star")}
          title={task.starred ? t("task.unstar") : t("task.star")}
          style={{
            ...s.taskStarBtn,
            opacity: task.starred ? 1 : hov ? 0.7 : 0,
            pointerEvents: task.starred || hov ? "auto" : "none",
            color: task.starred ? "var(--star-fg)" : "var(--text-hint)",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar();
          }}
        >
          <Star size={12} strokeWidth={2.2} fill={task.starred ? "currentColor" : "none"} />
        </button>
        {onRunTodo && (
          <button
            type="button"
            aria-label={t("task.runNow")}
            title={t("task.runNow")}
            style={{ ...s.taskPlayBtn, opacity: hov ? 1 : 0.5 }}
            onClick={(e) => {
              e.stopPropagation();
              onRunTodo();
            }}
          >
            <Play size={11} strokeWidth={2} fill="currentColor" />
          </button>
        )}
        <button
          type="button"
          aria-label={t("task.deleteTask")}
          title={t("task.deleteTask")}
          style={{
            ...s.taskDeleteBtn,
            opacity: hov ? 1 : 0,
            pointerEvents: hov ? "auto" : "none",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} strokeWidth={2.2} />
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.task === next.task &&
    prev.selected === next.selected &&
    (prev.onRunTodo !== undefined) === (next.onRunTodo !== undefined) &&
    prev.waitingBadgeKind === next.waitingBadgeKind &&
    prev.waitingBadgeCount === next.waitingBadgeCount &&
    prev.waitingBadgeBlocked === next.waitingBadgeBlocked,
);
