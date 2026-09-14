import { useMemo, useState, type CSSProperties } from "react";
import { ArchiveRestore, BookOpenText, Circle } from "lucide-react";
import type { Plan, Task } from "../../../types";
import {
  groupPlansForBoard,
  PLAN_BOARD_COLUMNS,
  type PlanBoardColumn,
} from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { shortenPath } from "../../../utils";
import { ProjectAvatar } from "../../ProjectAvatar";
import { useI18n, pluralKey } from "../../../i18n";
import { PlanBoardCard, planTitle } from "./PlanBoardCard";
import s from "../../../styles";

/** 每列最多渲染多少张卡片，超出折叠为 "+N more"（与任务看板一致）。 */
const COLUMN_LIMIT = 6;

const COLUMN_DOT: Record<PlanBoardColumn, CSSProperties> = {
  draft: s.boardColumnDotDraft,
  finalized: s.boardColumnDotFinalized,
  executing: s.boardColumnDotExecuting,
  completed: s.boardColumnDotCompleted,
  cancelled: s.boardColumnDotCancelled,
};

/**
 * 方案看板：跨项目分组 × 生命周期列（决策 S1）。卡片粒度是方案，展开可见议题任务级
 * 进度与依赖。生命周期动作（完成/重开/取消/归档/删除）由 App 注入，此组件保持展示职责。
 */
export function PlanBoard({
  plans,
  tasks,
  depsByPlanId,
  projectNames,
  projectPaths,
  onPreview,
  onOpenTask,
  onComplete,
  onReopen,
  onCancel,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  plans: Plan[];
  tasks: Task[];
  /** planId → 已解析 deps.json。 */
  depsByPlanId: Record<string, PlanDeps | undefined>;
  projectNames: Map<string, string>;
  projectPaths: Map<string, string>;
  onPreview: (plan: Plan) => void;
  onOpenTask: (taskId: string) => void;
  onComplete: (planId: string) => void;
  onReopen: (planId: string) => void;
  onCancel: (planId: string) => void;
  onArchive: (planId: string) => void;
  onUnarchive: (planId: string) => void;
  onDelete: (planId: string) => void;
}) {
  const { t } = useI18n();
  const [projectFilter, setProjectFilter] = useState("");
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string>>(() => new Set());
  // 归档区按项目独立展开（每个项目一条计数条）；用一个 Set 记录已展开的项目 id。
  const [archivedOpenProjectIds, setArchivedOpenProjectIds] = useState<Set<string>>(() => new Set());

  const toggleArchived = (projectId: string) => {
    setArchivedOpenProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const visiblePlans = useMemo(() => {
    if (!projectFilter.trim()) return plans;
    const q = projectFilter.trim().toLowerCase();
    return plans.filter((plan) => {
      const name = projectNames.get(plan.projectId) ?? "";
      return planTitle(plan).toLowerCase().includes(q) || name.toLowerCase().includes(q);
    });
  }, [plans, projectFilter, projectNames]);

  const groups = useMemo(() => groupPlansForBoard(visiblePlans), [visiblePlans]);
  const totalActive = groups.reduce((sum, g) => sum + g.activeCount, 0);

  const toggleExpand = (planId: string) => {
    setExpandedPlanIds((prev) => {
      const next = new Set(prev);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  };

  if (plans.length === 0) {
    return (
      <div style={s.kanbanEmpty}>
        <Circle size={28} strokeWidth={1.2} color="var(--text-hint)" />
        <div>{t("board.empty")}</div>
      </div>
    );
  }

  return (
    <>
      <div style={s.boardToolbar}>
        <div style={s.kanbanSubtitle}>
          {t("board.summary", { projects: groups.length, plans: totalActive })}
        </div>
        <input
          style={s.boardFilterInput}
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          placeholder={t("board.title")}
          aria-label={t("board.title")}
        />
      </div>

      {groups.map((group) => {
        const projectName = projectNames.get(group.projectId) ?? group.projectId;
        const projectPath = projectPaths.get(group.projectId) ?? "";
        return (
          <section key={group.projectId} style={s.kanbanProjectBlock}>
            <div style={s.kanbanProjectHeader} title={projectPath}>
              <ProjectAvatar name={projectName} size={18} />
              <span style={s.kanbanProjectName}>{projectName}</span>
              {projectPath ? (
                <span style={s.kanbanProjectPath}>{shortenPath(projectPath)}</span>
              ) : null}
              <span style={s.kanbanProjectCount}>
                {t(pluralKey("kanban.activeCount", "kanban.activeCountPlural", group.activeCount), {
                  count: group.activeCount,
                })}
              </span>
            </div>

            <div style={s.boardColumns}>
              {PLAN_BOARD_COLUMNS.map((column) => {
                const columnPlans = group.columns[column];
                const visible = columnPlans.slice(0, COLUMN_LIMIT);
                const overflow = columnPlans.length - visible.length;
                return (
                  <div key={column} style={s.kanbanColumn}>
                    <div style={s.kanbanColumnHeader}>
                      <span style={COLUMN_DOT[column]} aria-hidden />
                      <span style={s.kanbanColumnTitle}>{t(`board.column.${column}`)}</span>
                      <span style={s.kanbanColumnCount}>{columnPlans.length}</span>
                    </div>
                    {visible.length === 0 ? (
                      <div style={s.kanbanColumnEmpty}>—</div>
                    ) : (
                      visible.map((plan) => (
                        <PlanBoardCard
                          key={plan.id}
                          plan={plan}
                          tasks={tasks}
                          deps={depsByPlanId[plan.id]}
                          expanded={expandedPlanIds.has(plan.id)}
                          onToggleExpand={() => toggleExpand(plan.id)}
                          onPreview={() => onPreview(plan)}
                          onOpenTask={onOpenTask}
                          onComplete={() => onComplete(plan.id)}
                          onReopen={() => onReopen(plan.id)}
                          onCancel={() => onCancel(plan.id)}
                          onArchive={() => onArchive(plan.id)}
                          onDelete={() => onDelete(plan.id)}
                        />
                      ))
                    )}
                    {overflow > 0 ? <div style={s.kanbanColumnMore}>+{overflow} more</div> : null}
                  </div>
                );
              })}
            </div>

            {group.archived.length > 0 && (
              <>
                <button
                  type="button"
                  style={s.boardArchiveBar}
                  onClick={() => toggleArchived(group.projectId)}
                >
                  <ArchiveRestore size={12} strokeWidth={2} />
                  {t("board.archivedBar", { count: group.archived.length })}
                </button>
                {archivedOpenProjectIds.has(group.projectId) && (
                  <div style={s.boardArchiveList}>
                    {group.archived.map((plan) => (
                      <div key={plan.id} style={s.boardArchiveRow}>
                        <span style={s.boardArchiveName}>{planTitle(plan)}</span>
                        <span style={s.boardStatusBadge}>{t(`board.column.${plan.status}`)}</span>
                        <button
                          type="button"
                          style={s.boardMiniBtn}
                          onClick={() => onUnarchive(plan.id)}
                        >
                          <ArchiveRestore size={11} strokeWidth={2} />
                          {t("board.unarchive")}
                        </button>
                        <button
                          type="button"
                          style={s.boardIconBtn}
                          title={t("board.preview")}
                          aria-label={t("board.preview")}
                          onClick={() => onPreview(plan)}
                        >
                          <BookOpenText size={12} strokeWidth={2} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
