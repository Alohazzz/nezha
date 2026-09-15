import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BookOpenText,
  ChevronLeft,
  MessageSquare,
  PlayCircle,
  RotateCcw,
  Trash2,
  XCircle,
} from "lucide-react";
import type { Plan, Task } from "../../../types";
import type { PlanTaskRows } from "../../../utils/planBoard";
import { planLifecycleActions } from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { planGraphNeighborhood, type PlanGraphUpstream } from "../../../utils/planGraph";
import { planTitle } from "../../../utils/plan";
import { shortenPath } from "../../../utils";
import { useI18n } from "../../../i18n";
import s from "../../../styles";
import { PlanDepGraph } from "./PlanDepGraph";
import { PlanTaskRowView } from "./PlanTaskRow";

/** 无高亮时的空集合：保持引用稳定，避免每帧新建 Set 触发下游重渲染。 */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
const EMPTY_UPSTREAM: readonly PlanGraphUpstream[] = [];

/**
 * 方案详情（右栏）：头部摘要 + 生命周期动作（**常驻**，不再 hover 才出现）+ 依赖图 +
 * 任务列表。draft 方案没有可执行任务，改为在依赖图位置放讨论卡。
 *
 * 图与列表的联动状态收在这里：`hoverSerial` 是瞬时悬停，`selectedSerial` 是点击后的
 * 停留选中；高亮集合取二者的依赖邻域（自身 + 上下游传递闭包）。
 *
 * 追加子方案（阶段三）：头部显示归属（「追加自 ↗ 主方案」/「追加子方案 N 个」），
 * 依赖图里把跨方案前置画成上游节点（`upstream`）。
 */
export function PlanDetail({
  plan,
  projectName,
  projectPath,
  tasks,
  summary,
  deps,
  upstream = EMPTY_UPSTREAM,
  depsLoading,
  parentPlanName,
  childPlans,
  onOpenPlan,
  now,
  onPreview,
  onOpenTask,
  onComplete,
  onReopen,
  onCancel,
  onArchive,
  onDelete,
  onNarrowBack,
}: {
  plan: Plan;
  projectName: string;
  projectPath: string;
  tasks: readonly Task[];
  summary: PlanTaskRows;
  deps?: PlanDeps;
  /** 跨方案前置议题（追加子方案）：画进图里，避免子议题装作「无前置」。 */
  upstream?: readonly PlanGraphUpstream[];
  depsLoading: boolean;
  /** 本方案的上级方案名（追加来源）；根方案为 undefined。 */
  parentPlanName?: string;
  /** 追加到本方案下的子方案（用于头部计数与跳转）。 */
  childPlans?: readonly Plan[];
  /** 跳转到另一个方案（点上游节点 / 点父方案 / 点子方案）。 */
  onOpenPlan?: (planId: string) => void;
  /** 统一时间基准（运行时长计算），避免每行各调 Date.now。 */
  now: number;
  onPreview: () => void;
  onOpenTask: (taskId: string) => void;
  onComplete: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** 窄窗下返回方案列表（宽窗下按钮被 CSS 隐藏）。 */
  onNarrowBack: () => void;
}) {
  const { t } = useI18n();
  const actions = planLifecycleActions(plan);
  const total = summary.total;
  const percent = total > 0 ? Math.round((summary.done / total) * 100) : 0;

  /** 瞬时悬停（鼠标离开即清）；点击后的停留选中（用于把某条依赖链钉住看）。 */
  const [hoverSerial, setHoverSerial] = useState<string | null>(null);
  const [selectedSerial, setSelectedSerial] = useState<string | null>(null);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const registerRef = useCallback((serial: string, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(serial, element);
    else rowRefs.current.delete(serial);
  }, []);

  // 切换方案时清掉停留选中，避免把上一个方案的编号带进来。
  useEffect(() => {
    setSelectedSerial(null);
    setHoverSerial(null);
  }, [plan.id]);

  // 高亮的驱动项：悬停优先，其次是点击后的停留选中。
  const driverSerial = hoverSerial ?? selectedSerial;
  const hotSerials = useMemo<ReadonlySet<string>>(() => {
    if (!driverSerial) return EMPTY_SET;
    return planGraphNeighborhood(driverSerial, deps?.graph ?? {});
  }, [driverSerial, deps]);

  const focusSerial = useCallback((serial: string) => {
    setSelectedSerial(serial);
    const element = rowRefs.current.get(serial);
    // jsdom 没有 scrollIntoView；窄窗下列表可能在屏外，故只在存在时滚动。
    element?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, []);

  const discussionTask = plan.discussionTaskId
    ? tasks.find((task) => task.id === plan.discussionTaskId)
    : undefined;

  return (
    <section className="plan-detail" aria-label={planTitle(plan)}>
      <header className="plan-detail-head">
        <div className="plan-detail-head-top">
          <button
            type="button"
            className="plan-narrow-back"
            onClick={onNarrowBack}
            aria-label={t("board.backToList")}
          >
            <ChevronLeft size={13} strokeWidth={2} />
            {t("board.backToList")}
          </button>
          <span className="plan-detail-title" title={planTitle(plan)}>
            {planTitle(plan)}
          </span>
          <span style={s.planStatusBadge}>{t(`board.column.${plan.status}`)}</span>
          <span className="plan-detail-head-actions">
            <button type="button" style={s.boardMiniBtn} onClick={onPreview}>
              <BookOpenText size={11} strokeWidth={2} />
              {t("board.preview")}
            </button>
            {actions.canComplete && (
              <button type="button" style={s.boardMiniBtnPrimary} onClick={onComplete}>
                <PlayCircle size={11} strokeWidth={2} />
                {t("board.complete")}
              </button>
            )}
            {actions.canReopen && (
              <button type="button" style={s.boardMiniBtn} onClick={onReopen}>
                <RotateCcw size={11} strokeWidth={2} />
                {t("board.reopen")}
              </button>
            )}
            {actions.canArchive && (
              <button type="button" style={s.boardMiniBtn} onClick={onArchive}>
                <Archive size={11} strokeWidth={2} />
                {t("board.archive")}
              </button>
            )}
            {actions.canCancel && (
              <button type="button" style={s.boardMiniBtn} onClick={onCancel}>
                <XCircle size={11} strokeWidth={2} />
                {t("board.cancel")}
              </button>
            )}
            <button
              type="button"
              style={s.boardMiniBtnDanger}
              title={t("board.deleteHint")}
              aria-label={t("board.delete")}
              onClick={onDelete}
            >
              <Trash2 size={11} strokeWidth={2} />
            </button>
          </span>
        </div>

        <div className="plan-detail-meta">
          {parentPlanName && onOpenPlan && plan.parentPlanId ? (
            <button
              type="button"
              className="plan-detail-parent"
              title={t("board.parentPlanHint", { plan: parentPlanName })}
              onClick={() => onOpenPlan(plan.parentPlanId as string)}
            >
              {t("board.parentPlan", { plan: parentPlanName })}
            </button>
          ) : null}
          {childPlans && childPlans.length > 0 ? (
            <span className="plan-detail-children">
              <span className="plan-detail-children-label">
                {t("board.childPlans", { count: childPlans.length })}
              </span>
              {childPlans.map((child) => (
                <button
                  key={child.id}
                  type="button"
                  className="plan-detail-child"
                  title={planTitle(child)}
                  onClick={() => onOpenPlan?.(child.id)}
                >
                  {planTitle(child)}
                </button>
              ))}
            </span>
          ) : null}
          {total > 0 && (
            <span className="plan-detail-progress">
              <span className="plan-detail-progress-track">
                <span className="plan-fill" style={{ width: `${percent}%` }} />
              </span>
              <span className="plan-detail-progress-label" key={summary.done}>
                {t("board.progress", { done: summary.done, total })}
              </span>
            </span>
          )}
          {summary.unmetEdges > 0 ? (
            <span style={s.planBadgeWaiting}>
              {t("board.blocked", { count: summary.unmetEdges })}
            </span>
          ) : null}
          {summary.noTasks ? <span style={s.planBadgeLocked}>{t("board.noTasks")}</span> : null}
          {actions.canComplete && summary.allDone ? (
            <span style={s.planBadgeReady}>{t("board.readyHint")}</span>
          ) : null}
          <span className="plan-detail-path" title={`${projectName} · ${projectPath}`}>
            {projectName}
            {projectPath ? ` · ${shortenPath(projectPath)}` : ""}
          </span>
        </div>
      </header>

      <div className="plan-detail-body">
        {plan.status === "draft" ? (
          <div style={s.planDiscussionCard}>
            <span style={s.planDiscussionTitle}>{t("board.discuss.title")}</span>
            <span style={s.planDiscussionHint}>{t("board.discuss.hint")}</span>
            <span style={s.planDiscussionActions}>
              {discussionTask ? (
                <button
                  type="button"
                  style={s.boardMiniBtn}
                  onClick={() => onOpenTask(discussionTask.id)}
                >
                  <MessageSquare size={11} strokeWidth={2} />
                  {t("board.discuss.open")}
                </button>
              ) : null}
              <button type="button" style={s.boardMiniBtn} onClick={onPreview}>
                <BookOpenText size={11} strokeWidth={2} />
                {t("board.discuss.readPlan")}
              </button>
            </span>
          </div>
        ) : null}

        <PlanDepGraph
          rows={summary.rows}
          deps={deps}
          upstream={upstream}
          hotSerials={hotSerials}
          onHoverSerial={setHoverSerial}
          onFocusSerial={focusSerial}
          onOpenUpstream={(planId) => onOpenPlan?.(planId)}
          loading={depsLoading}
        />

        <section className="plan-task-list" aria-label={t("board.taskListTitle")}>
          <div className="plan-task-list-head">
            {t("board.taskListTitle")}
            {summary.runningCount > 0 ? (
              <span style={s.planBadgeWaiting}>
                {t("board.runningCount", { count: summary.runningCount })}
              </span>
            ) : null}
          </div>
          {summary.rows.length === 0 ? (
            <div className="plan-graph-empty">{t("board.noIssues")}</div>
          ) : (
            summary.rows.map((row, index) => (
              <PlanTaskRowView
                key={row.workitemId}
                row={row}
                index={index + 1}
                now={now}
                hotSerials={hotSerials}
                registerRef={registerRef}
                onHoverSerial={setHoverSerial}
                onFocusSerial={focusSerial}
                onOpenTask={onOpenTask}
              />
            ))
          )}
        </section>
      </div>
    </section>
  );
}
