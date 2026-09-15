import { useEffect, useMemo, useState } from "react";
import { ArchiveRestore, BookOpenText, Circle } from "lucide-react";
import type { Plan, Task } from "../../../types";
import {
  derivePlanTaskRows,
  groupPlansByProject,
  isPlanArchived,
  PLAN_STATUS_ORDER,
} from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { shortenPath } from "../../../utils";
import { ProjectAvatar } from "../../ProjectAvatar";
import { FilterMultiSelect, type FilterOption } from "../FilterMultiSelect";
import { useI18n, pluralKey } from "../../../i18n";
import { planTitle, PlanGroup } from "./PlanGroup";
import s from "../../../styles";

/** 运行时长每分钟刷新一次（只需「12m → 13m」这种粒度，不必每秒重渲染）。 */
const RUNTIME_TICK_MS = 60_000;

/**
 * 方案看板（**任务为主体**，决策 S1 跨项目总览）：按项目分组，组内每个方案是一个
 * 可折叠分组——表头是该方案的摘要（生命周期 / 进度 / 约束 / 动作），主体是它的任务行
 * （状态 / 运行情况 / 前置约束）。方案退为分组容器，重心落在任务上。
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
  const [query, setQuery] = useState("");
  /** 方案状态多选（空选 = 不限）；纯展示层筛选，不影响方案真实状态。 */
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  /** 只保留「有任务在动」的方案。 */
  const [livelyOnly, setLivelyOnly] = useState(false);
  // null = 尚未用户干预：默认展开「有任务在动」的方案，折叠完全静止的。
  const [expandedPlanIds, setExpandedPlanIds] = useState<Set<string> | null>(null);
  const [archivedOpenProjectIds, setArchivedOpenProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), RUNTIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * 有任务在「动」的方案（在跑 / 等待 / 异常）。**对所有方案计算**：活跃与否是方案自身
   * 的属性，不该随筛选结果漂移（否则「仅看进行中」会和自己的输入互为条件）。
   * 同时用于分组排序与默认展开。
   */
  const livelyPlanIds = useMemo(() => {
    const ids = new Set<string>();
    for (const plan of plans) {
      const summary = derivePlanTaskRows(plan, tasks, depsByPlanId[plan.id]);
      const hasLivelyTask = summary.rows.some(
        (row) =>
          row.status === "running" ||
          row.status === "pending" ||
          row.status === "input_required" ||
          row.status === "awaiting_review" ||
          row.status === "waiting_deps" ||
          row.status === "failed" ||
          row.status === "interrupted",
      );
      if (hasLivelyTask) ids.add(plan.id);
    }
    return ids;
  }, [plans, tasks, depsByPlanId]);

  // 筛选只发生在展示层：状态（多选）+ 名称/项目（自由文本）+ 仅看进行中。已归档方案
  // 同样受状态与文本筛选约束，避免筛选态下归档区仍混进不匹配的方案。
  const visiblePlans = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plans.filter((plan) => {
      if (statusFilter.length > 0 && !statusFilter.includes(plan.status)) return false;
      if (livelyOnly && (isPlanArchived(plan) || !livelyPlanIds.has(plan.id))) return false;
      if (!q) return true;
      const projectName = projectNames.get(plan.projectId) ?? "";
      return planTitle(plan).toLowerCase().includes(q) || projectName.toLowerCase().includes(q);
    });
  }, [plans, query, projectNames, statusFilter, livelyOnly, livelyPlanIds]);

  const statusOptions = useMemo<FilterOption[]>(
    () => PLAN_STATUS_ORDER.map((status) => ({ id: status, label: t(`board.column.${status}`) })),
    [t],
  );
  const filtersActive = query.trim().length > 0 || statusFilter.length > 0 || livelyOnly;
  const clearFilters = () => {
    setQuery("");
    setStatusFilter([]);
    setLivelyOnly(false);
  };

  const groups = useMemo(
    () => groupPlansByProject(visiblePlans, livelyPlanIds),
    [visiblePlans, livelyPlanIds],
  );

  const effectiveExpanded = expandedPlanIds ?? livelyPlanIds;
  const toggleExpand = (planId: string) => {
    setExpandedPlanIds((prev) => {
      const base = prev ?? new Set(livelyPlanIds);
      const next = new Set(base);
      if (next.has(planId)) next.delete(planId);
      else next.add(planId);
      return next;
    });
  };
  const toggleArchived = (projectId: string) => {
    setArchivedOpenProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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

  const totalActive = groups.reduce((sum, g) => sum + g.activePlanCount, 0);

  return (
    <>
      <div style={s.boardToolbar}>
        <div style={s.kanbanSubtitle}>
          {t("board.summary", { projects: groups.length, plans: totalActive })}
        </div>
        <button
          type="button"
          style={livelyOnly ? s.yunxiaoFilterBtnActive : s.yunxiaoFilterBtn}
          aria-pressed={livelyOnly}
          onClick={() => setLivelyOnly((prev) => !prev)}
        >
          {t("board.livelyOnly")}
        </button>
        <FilterMultiSelect
          options={statusOptions}
          selectedIds={statusFilter}
          onChange={setStatusFilter}
          label={t("board.statusFilter")}
          selectedLabel={t("board.statusCount", { count: statusFilter.length })}
          emptyLabel={t("board.statusFilter")}
        />
        <input
          style={s.boardFilterInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("board.filterPlaceholder")}
          aria-label={t("board.filterPlaceholder")}
        />
      </div>

      {visiblePlans.length === 0 ? (
        <div style={s.kanbanEmpty}>
          <Circle size={28} strokeWidth={1.2} color="var(--text-hint)" />
          <div>{t("board.filterEmpty")}</div>
          {filtersActive && (
            <button type="button" style={s.boardMiniBtn} onClick={clearFilters}>
              {t("board.clearFilters")}
            </button>
          )}
        </div>
      ) : null}

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
                {t(pluralKey("kanban.activeCount", "kanban.activeCountPlural", group.activePlanCount), {
                  count: group.activePlanCount,
                })}
              </span>
            </div>

            {group.plans.map((plan) => (
              <PlanGroup
                key={plan.id}
                plan={plan}
                tasks={tasks}
                deps={depsByPlanId[plan.id]}
                expanded={effectiveExpanded.has(plan.id)}
                onToggleExpand={() => toggleExpand(plan.id)}
                now={now}
                onPreview={() => onPreview(plan)}
                onOpenTask={onOpenTask}
                onComplete={() => onComplete(plan.id)}
                onReopen={() => onReopen(plan.id)}
                onCancel={() => onCancel(plan.id)}
                onArchive={() => onArchive(plan.id)}
                onDelete={() => onDelete(plan.id)}
              />
            ))}

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
