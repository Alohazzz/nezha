import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Circle, FolderOpen } from "lucide-react";
import * as RadixPopover from "@radix-ui/react-popover";
import type { Plan, Task } from "../../../types";
import {
  buildPlanTree,
  derivePlanTaskRows,
  isPlanArchived,
  PLAN_STATUS_ORDER,
} from "../../../utils/planBoard";
import type { PlanDeps } from "../../../utils/planDeps";
import { deriveUpstreamGraphNodes } from "../../../utils/planGraph";
import { planAncestorChain, planTitle } from "../../../utils/plan";
import { ProjectAvatar } from "../../ProjectAvatar";
import type { FilterOption } from "../FilterMultiSelect";
import { useI18n } from "../../../i18n";
import s from "../../../styles";
import { PlanRail, type PlanRailFilters } from "./PlanRail";
import { PlanDetail } from "./PlanDetail";

/** 运行时长每分钟刷新一次（只需「12m → 13m」粒度，不必每秒重渲染）。 */
const RUNTIME_TICK_MS = 60_000;

/** 任务是否处于「有东西在动」的状态（在跑 / 等待 / 异常）。 */
function isLivelyStatus(status: Task["status"]): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "input_required" ||
    status === "awaiting_review" ||
    status === "waiting_deps" ||
    status === "failed" ||
    status === "interrupted"
  );
}

/**
 * 方案看板 v2：**页面专注一个方案**。
 *
 * - 项目上抽一级：顶部项目切换器锁定单个项目。切换**不影响应用的活动项目**——看板是
 *   只读总览，不该把上下文拽走；跨项目总览交给任务看板 tab。
 * - 方案上抽一级：左栏方案列表（筛选 + 已归档），右栏是选中方案的详情（依赖图 + 任务行）。
 * - 面包屑：`[项目▾] / 方案名`，项目节点本身即切换器。
 */
export function PlanBoard({
  plans,
  tasks,
  depsByPlanId,
  projectNames,
  projectPaths,
  activeProjectId,
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
  /** 应用当前活动项目（作为看板锁定项目的初值）。 */
  activeProjectId?: string | null;
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

  const [projectId, setProjectId] = useState<string | null>(() => {
    if (activeProjectId && plans.some((plan) => plan.projectId === activeProjectId)) {
      return activeProjectId;
    }
    // 回落到「方案最多的项目」，避免初值指向一个空项目。
    const counts = new Map<string, number>();
    for (const plan of plans) counts.set(plan.projectId, (counts.get(plan.projectId) ?? 0) + 1);
    let best: string | null = null;
    for (const [id, count] of counts) {
      if (best === null || count > (counts.get(best) ?? 0)) best = id;
    }
    return best;
  });
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [livelyOnly, setLivelyOnly] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /** 窄窗单栏视图：列表 → 点方案进详情 → 返回（宽窗下由 CSS 忽略此属性）。 */
  const [narrowView, setNarrowView] = useState<"list" | "detail">("list");
  /** 用户手动折叠的方案 id（子树缩进树的折叠态）。 */
  const [collapsedPlanIds, setCollapsedPlanIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), RUNTIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  /** 可选项目：有方案的项目 ∪ 已知项目名（空项目也可切，便于确认「本项目确实没方案」）。 */
  const projectOptions = useMemo(() => {
    const ids = new Set<string>(plans.map((plan) => plan.projectId));
    for (const id of projectNames.keys()) ids.add(id);
    return Array.from(ids)
      .map((id) => ({
        id,
        name: projectNames.get(id) ?? id,
        planCount: plans.filter((plan) => plan.projectId === id).length,
      }))
      .sort((a, b) => b.planCount - a.planCount || a.name.localeCompare(b.name));
  }, [plans, projectNames]);

  // 当前项目被删/切走时兜底：不在可选列表里就回到第一个。
  const effectiveProjectId =
    projectId && projectOptions.some((option) => option.id === projectId)
      ? projectId
      : (projectOptions[0]?.id ?? null);

  const projectPlans = useMemo(
    () => plans.filter((plan) => plan.projectId === effectiveProjectId),
    [plans, effectiveProjectId],
  );

  /**
   * 任务行汇总**对本项目所有方案一次性算好**：同一帧里左栏（进度/受阻）与右栏
   * （图 + 行）都要用，算两遍纯浪费；且「活跃」是方案自身属性，不该随筛选漂移。
   */
  const summaries = useMemo(() => {
    const map = new Map<string, ReturnType<typeof derivePlanTaskRows>>();
    for (const plan of projectPlans) {
      map.set(plan.id, derivePlanTaskRows(plan, tasks, depsByPlanId[plan.id]));
    }
    return map;
  }, [projectPlans, tasks, depsByPlanId]);

  const livelyPlanIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, summary] of summaries) {
      if (summary.rows.some((row) => row.status !== null && isLivelyStatus(row.status))) {
        ids.add(id);
      }
    }
    return ids;
  }, [summaries]);

  const matchesFilters = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (plan: Plan): boolean => {
      if (statusFilter.length > 0 && !statusFilter.includes(plan.status)) return false;
      if (livelyOnly && !livelyPlanIds.has(plan.id)) return false;
      if (!q) return true;
      return planTitle(plan).toLowerCase().includes(q);
    };
  }, [query, statusFilter, livelyOnly, livelyPlanIds]);

  /** 是否有任一筛选生效：同时决定空态文案与「折叠是否强制展开命中分支」。 */
  const filtersActive = query.trim().length > 0 || statusFilter.length > 0 || livelyOnly;

  /**
   * 活跃方案排好序后交给 `buildPlanTree` 做**子树语义筛选 + 缩进树**：
   * 任一方案命中即展示其整条祖先链（无孤儿行），折叠不吞掉命中分支。
   * 排序仍按「有任务在动优先，其次 createdAt 升序」，树内父子沿用该顺序深度优先。
   */
  const activeOrdered = useMemo(
    () =>
      projectPlans
        .filter((plan) => !isPlanArchived(plan))
        .sort((a, b) => {
          const aLively = livelyPlanIds.has(a.id) ? 0 : 1;
          const bLively = livelyPlanIds.has(b.id) ? 0 : 1;
          if (aLively !== bLively) return aLively - bLively;
          return a.createdAt - b.createdAt;
        }),
    [projectPlans, livelyPlanIds],
  );

  const treeRows = useMemo(
    () => buildPlanTree(activeOrdered, matchesFilters, collapsedPlanIds, filtersActive),
    [activeOrdered, matchesFilters, collapsedPlanIds, filtersActive],
  );

  /** 树里的可见方案集合：选中回落与「筛选是否把它排除」都以它为准。 */
  const visiblePlans = useMemo(() => treeRows.map((row) => row.plan), [treeRows]);

  const visibleArchived = useMemo(
    () =>
      projectPlans
        .filter((plan) => isPlanArchived(plan) && matchesFilters(plan))
        .sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt)),
    [projectPlans, matchesFilters],
  );

  /**
   * 选中项优先取显式选择（左栏点击，含从「已归档」里点开），但它必须仍在**可见列表**里；
   * 筛选把它排除掉时回落到第一个可见方案。这样右栏永远不会显示一个「列表里已消失的方案」。
   *
   * 自动回落**只看活跃方案**：已归档的必须显式点开，否则「归档」就等于没把它移出主视图。
   */
  const explicitSelection = useMemo(() => {
    if (!selectedPlanId) return null;
    return (
      visiblePlans.find((plan) => plan.id === selectedPlanId) ??
      visibleArchived.find((plan) => plan.id === selectedPlanId) ??
      null
    );
  }, [selectedPlanId, visiblePlans, visibleArchived]);

  const selectedPlan = explicitSelection ?? visiblePlans[0] ?? null;

  const statusOptions = useMemo<FilterOption[]>(
    () => PLAN_STATUS_ORDER.map((status) => ({ id: status, label: t(`board.column.${status}`) })),
    [t],
  );

  const clearFilters = () => {
    setQuery("");
    setStatusFilter([]);
    setLivelyOnly(false);
  };

  const railFilters: PlanRailFilters = {
    query,
    onQueryChange: setQuery,
    statusFilter,
    onStatusFilterChange: setStatusFilter,
    statusOptions,
    livelyOnly,
    onLivelyOnlyChange: setLivelyOnly,
    active: filtersActive,
    onClear: clearFilters,
  };

  const projectName = effectiveProjectId
    ? (projectNames.get(effectiveProjectId) ?? effectiveProjectId)
    : "";
  const projectPath = effectiveProjectId ? (projectPaths.get(effectiveProjectId) ?? "") : "";
  const summary = selectedPlan ? summaries.get(selectedPlan.id) : undefined;

  /** 选中方案的上级方案名（追加来源）：只看本项目已加载的祖先链，断链即不显示。 */
  const selectedParentName = useMemo(() => {
    if (!selectedPlan) return undefined;
    const [parent] = planAncestorChain(selectedPlan.id, projectPlans);
    return parent ? planTitle(parent) : undefined;
  }, [selectedPlan, projectPlans]);

  /** 直接追加到选中方案下的子方案（含被筛选隐藏的——归属是方案自身属性）。 */
  const selectedChildPlans = useMemo(() => {
    if (!selectedPlan) return [];
    return projectPlans
      .filter((plan) => plan.parentPlanId === selectedPlan.id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [selectedPlan, projectPlans]);

  /** 图里的跨方案前置：只画被本方案议题直接引用的祖先议题。 */
  const selectedUpstream = useMemo(() => {
    if (!selectedPlan) return [];
    return deriveUpstreamGraphNodes(
      selectedPlan,
      plans,
      tasks,
      depsByPlanId[selectedPlan.id],
    );
  }, [selectedPlan, plans, tasks, depsByPlanId]);

  /** 点父方案 / 子方案 / 图上游节点时的统一跳转（同一项目内）。 */
  const openPlan = (planId: string) => {
    setSelectedPlanId(planId);
    setNarrowView("detail");
  };

  /**
   * planId → 直接上级方案名。左栏主列用缩进表达归属，**归档区保持平铺**，
   * 所以那里要靠这张表显示「↳ 主方案名」，保证同一层归属在全看板口径一致。
   */
  const parentNameByPlanId = useMemo(() => {
    const byId = new Map(projectPlans.map((plan) => [plan.id, plan]));
    const names = new Map<string, string>();
    for (const plan of projectPlans) {
      const parentId = plan.parentPlanId?.trim();
      const parent = parentId ? byId.get(parentId) : undefined;
      if (parent) names.set(plan.id, planTitle(parent));
    }
    return names;
  }, [projectPlans]);

  if (plans.length === 0 && projectOptions.length === 0) {
    return (
      <div className="plan-rail-empty">
        <Circle size={26} strokeWidth={1.2} />
        <div>{t("board.empty")}</div>
      </div>
    );
  }

  return (
    <div className="plan-board-shell" data-narrow-view={narrowView}>
      <div className="plan-crumbs">
        <RadixPopover.Root open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
          <RadixPopover.Trigger asChild>
            <button type="button" style={s.planCrumbProject} aria-label={t("board.projectSwitch")}>
              {projectName ? (
                <ProjectAvatar name={projectName} size={15} />
              ) : (
                <FolderOpen size={13} strokeWidth={2} />
              )}
              {projectName || t("board.noProject")}
              <ChevronDown
                size={12}
                strokeWidth={2}
                className="plan-crumb-chevron"
                data-open={String(projectPickerOpen)}
              />
            </button>
          </RadixPopover.Trigger>
          <RadixPopover.Portal>
            <RadixPopover.Content sideOffset={4} align="start" style={s.yunxiaoFilterPopover}>
              <div style={s.yunxiaoFilterPopoverHeader}>
                <span>{t("board.projectSwitch")}</span>
              </div>
              <div style={s.yunxiaoFilterOptions}>
                {projectOptions.map((option) => {
                  const selected = option.id === effectiveProjectId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className="plan-project-option"
                      data-selected={String(selected)}
                      aria-pressed={selected}
                      onClick={() => {
                        setProjectId(option.id);
                        setSelectedPlanId(null);
                        setNarrowView("list");
                        setProjectPickerOpen(false);
                      }}
                    >
                      <span className="plan-project-option-name">{option.name}</span>
                      <span className="plan-project-option-count">
                        {t("board.planCount", { count: option.planCount })}
                      </span>
                      {selected ? <Check size={12} strokeWidth={2.5} /> : null}
                    </button>
                  );
                })}
              </div>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>

        <span className="plan-crumb-sep">/</span>
        <span className="plan-crumb-current" title={selectedPlan ? planTitle(selectedPlan) : ""}>
          {selectedPlan ? planTitle(selectedPlan) : t("board.noSelection")}
        </span>

        <span className="plan-crumbs-spacer" />
        <span className="plan-crumbs-summary">
          {t("board.projectSummary", {
            plans: visiblePlans.length,
            active: livelyPlanIds.size,
          })}
        </span>
      </div>

      <div className="plan-board-main">
        <PlanRail
          treeRows={treeRows}
          archived={visibleArchived}
          summaries={summaries}
          livelyPlanIds={livelyPlanIds}
          selectedPlanId={selectedPlan?.id ?? null}
          collapsedPlanIds={collapsedPlanIds}
          onToggleCollapse={(planId) =>
            setCollapsedPlanIds((prev) => {
              const next = new Set(prev);
              if (next.has(planId)) next.delete(planId);
              else next.add(planId);
              return next;
            })
          }
          onSelect={(planId) => {
            setSelectedPlanId(planId);
            setNarrowView("detail");
          }}
          parentNameByPlanId={parentNameByPlanId}
          filters={railFilters}
          archivedOpen={archivedOpen}
          onToggleArchived={() => setArchivedOpen((prev) => !prev)}
          onPreview={onPreview}
          onUnarchive={onUnarchive}
        />

        {selectedPlan && summary ? (
          <PlanDetail
            key={selectedPlan.id}
            plan={selectedPlan}
            projectName={projectName}
            projectPath={projectPath}
            tasks={tasks}
            summary={summary}
            deps={depsByPlanId[selectedPlan.id]}
            upstream={selectedUpstream}
            depsLoading={depsByPlanId[selectedPlan.id] === undefined}
            parentPlanName={selectedParentName}
            childPlans={selectedChildPlans}
            onOpenPlan={openPlan}
            now={now}
            onPreview={() => onPreview(selectedPlan)}
            onOpenTask={onOpenTask}
            onComplete={() => onComplete(selectedPlan.id)}
            onReopen={() => onReopen(selectedPlan.id)}
            onCancel={() => onCancel(selectedPlan.id)}
            onArchive={() => onArchive(selectedPlan.id)}
            onDelete={() => onDelete(selectedPlan.id)}
            onNarrowBack={() => setNarrowView("list")}
          />
        ) : (
          // 「没有符合筛选的方案 / 暂无方案」由左栏统一说明，右栏不重复同一句。
          // 唯一需要右栏自己说话的场合：本项目有方案但全被归档（活跃列表为空、
          // 左栏只剩「已归档」折叠条），此时右栏空白会让人以为功能坏了。
          <div className="plan-detail">
            {projectPlans.length > 0 && !filtersActive ? (
              <div className="plan-rail-empty">
                <Circle size={22} strokeWidth={1.2} />
                <div>{t("board.selectHint")}</div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
