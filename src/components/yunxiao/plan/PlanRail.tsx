import { ArchiveRestore, BookOpenText, ChevronDown, Circle, Search } from "lucide-react";
import type { Plan } from "../../../types";
import type { PlanTaskRows, PlanTreeRow } from "../../../utils/planBoard";
import { planLifecycleActions } from "../../../utils/planBoard";
import { planTitle } from "../../../utils/plan";
import { FilterMultiSelect, type FilterOption } from "../FilterMultiSelect";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

export interface PlanRailFilters {
  query: string;
  onQueryChange: (value: string) => void;
  statusFilter: string[];
  onStatusFilterChange: (ids: string[]) => void;
  statusOptions: FilterOption[];
  livelyOnly: boolean;
  onLivelyOnlyChange: (value: boolean) => void;
  /** 是否有任一筛选生效（决定空态文案与「清除筛选」是否出现）。 */
  active: boolean;
  onClear: () => void;
}

/**
 * 方案看板左栏：筛选器（搜索 / 状态多选 / 仅看进行中）+ 当前项目的方案**缩进树** +
 * 已归档折叠区。右栏只展示选中的那一个方案——筛选与归档全部收在这一栏。
 *
 * 追加子方案（阶段三）以缩进挂在主方案下，且**不能被独立筛选**：`treeRows` 由
 * `buildPlanTree` 产出，已保证「任一命中即带出整条祖先链」且折叠不吞命中分支，
 * 本组件只按 `depth` 渲染缩进与折叠开关。
 */
export function PlanRail({
  treeRows,
  archived,
  summaries,
  livelyPlanIds,
  selectedPlanId,
  collapsedPlanIds,
  onToggleCollapse,
  parentNameByPlanId,
  onSelect,
  filters,
  archivedOpen,
  onToggleArchived,
  onPreview,
  onUnarchive,
}: {
  /** 已筛选（子树语义）、已排序的活跃方案树（深度优先，父在子前）。 */
  treeRows: PlanTreeRow[];
  /** 已筛选的归档方案（按归档时间倒序）。 */
  archived: Plan[];
  /** planId → 已派生的任务行汇总（与右栏共用同一份，避免重复推导）。 */
  summaries: Map<string, PlanTaskRows>;
  livelyPlanIds: ReadonlySet<string>;
  selectedPlanId: string | null;
  collapsedPlanIds: ReadonlySet<string>;
  onToggleCollapse: (planId: string) => void;
  /**
   * planId → 上级方案名：**全看板统一归属口径**。归档区保持平铺（不为它单独做树），
   * 但子方案在那里也照样显示「↳ 主方案名」，否则同一层归属在两种区域里说法不一致。
   */
  parentNameByPlanId: ReadonlyMap<string, string>;
  onSelect: (planId: string) => void;
  filters: PlanRailFilters;
  archivedOpen: boolean;
  onToggleArchived: () => void;
  onPreview: (plan: Plan) => void;
  onUnarchive: (planId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <aside className="plan-rail" aria-label={t("board.railLabel")}>
      <div className="plan-rail-filters">
        <div className="plan-rail-search-wrap">
          <Search size={11} strokeWidth={2} aria-hidden className="plan-rail-search-icon" />
          <input
            className="plan-rail-search plan-rail-search-with-icon"
            value={filters.query}
            onChange={(event) => filters.onQueryChange(event.target.value)}
            placeholder={t("board.filterPlaceholder")}
            aria-label={t("board.filterPlaceholder")}
          />
        </div>
        <div className="plan-rail-filter-row">
          <FilterMultiSelect
            options={filters.statusOptions}
            selectedIds={filters.statusFilter}
            onChange={filters.onStatusFilterChange}
            label={t("board.statusFilter")}
            selectedLabel={t("board.statusCount", { count: filters.statusFilter.length })}
            emptyLabel={t("board.statusFilter")}
          />
          <button
            type="button"
            style={filters.livelyOnly ? s.yunxiaoFilterBtnActive : s.yunxiaoFilterBtn}
            aria-pressed={filters.livelyOnly}
            onClick={() => filters.onLivelyOnlyChange(!filters.livelyOnly)}
          >
            {t("board.livelyOnly")}
          </button>
        </div>
      </div>

      {treeRows.length === 0 && archived.length === 0 ? (
        <div className="plan-rail-empty">
          <Circle size={22} strokeWidth={1.2} />
          <div>{filters.active ? t("board.filterEmpty") : t("board.empty")}</div>
          {filters.active && (
            <button type="button" style={s.boardMiniBtn} onClick={filters.onClear}>
              {t("board.clearFilters")}
            </button>
          )}
        </div>
      ) : (
        <div className="plan-rail-list">
          {treeRows.map(({ plan, depth, hasChildren, selfMatched }) => {
            const summary = summaries.get(plan.id);
            const total = summary?.total ?? plan.issues.length;
            const done = summary?.done ?? 0;
            const percent = total > 0 ? Math.round((done / total) * 100) : 0;
            const lively = livelyPlanIds.has(plan.id);
            const abnormal = (summary?.rows ?? []).some((row) => row.needsOverride);
            const ready =
              plan.status === "executing" &&
              (summary?.allDone ?? false) &&
              total > 0 &&
              planLifecycleActions(plan).canComplete;
            const collapsed = collapsedPlanIds.has(plan.id);

            return (
              <div
                key={plan.id}
                className="plan-rail-node"
                data-depth={depth > 0 ? String(depth) : undefined}
                // 为带出祖先而显示的父方案（自己没命中筛选）弱化显示，让命中项仍是视觉焦点。
                data-ancestor-only={!selfMatched && filters.active ? "true" : undefined}
              >
                <span className="plan-rail-node-gutter">
                  {hasChildren ? (
                    <button
                      type="button"
                      className="plan-rail-node-toggle"
                      data-open={String(!collapsed)}
                      aria-expanded={!collapsed}
                      aria-label={t(collapsed ? "board.expandChildren" : "board.collapseChildren", {
                        name: planTitle(plan),
                      })}
                      onClick={() => onToggleCollapse(plan.id)}
                    >
                      <ChevronDown size={11} strokeWidth={2.2} />
                    </button>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="plan-rail-item"
                  data-active={plan.id === selectedPlanId}
                  data-child={depth > 0 ? "true" : undefined}
                  aria-current={plan.id === selectedPlanId ? "true" : undefined}
                  onClick={() => onSelect(plan.id)}
                >
                  <span className="plan-rail-item-top">
                    <span
                      className="plan-rail-item-dot"
                      data-lively={String(lively)}
                      data-status={plan.status}
                    />
                    <span className="plan-rail-item-title" title={planTitle(plan)}>
                      {planTitle(plan)}
                    </span>
                    <span className="plan-rail-item-count">
                      {t("board.progress", { done, total })}
                    </span>
                  </span>

                  <span className="plan-rail-item-track">
                    <span className="plan-fill" style={{ width: `${percent}%` }} />
                  </span>

                  {abnormal || (summary?.unmetEdges ?? 0) > 0 || ready ? (
                    <span className="plan-rail-item-sub">
                      {abnormal ? (
                        <span className="plan-rail-item-sub-abnormal">{t("board.railAbnormal")}</span>
                      ) : (summary?.unmetEdges ?? 0) > 0 ? (
                        <span className="plan-rail-item-sub-blocked">
                          {t("board.blocked", { count: summary?.unmetEdges ?? 0 })}
                        </span>
                      ) : null}
                      {ready ? (
                        <span className="plan-rail-item-sub-ready">{t("board.railReady")}</span>
                      ) : null}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}

          {archived.length > 0 && (
            <>
              <div className="plan-rail-sep" />
              <button
                type="button"
                className="plan-rail-archived-toggle"
                aria-expanded={archivedOpen}
                onClick={onToggleArchived}
              >
                <ArchiveRestore size={11} strokeWidth={2} />
                {t("board.archivedBar", { count: archived.length })}
              </button>
              {archivedOpen && (
                <div className="plan-rail-archived-list">
                  {archived.map((plan) => {
                    const parentName = parentNameByPlanId.get(plan.id);
                    return (
                      <div key={plan.id} className="plan-rail-archived-row">
                        <button
                          type="button"
                          className="plan-rail-archived-name"
                          onClick={() => onSelect(plan.id)}
                          title={planTitle(plan)}
                        >
                          {planTitle(plan)}
                          {parentName ? (
                            <span className="plan-rail-archived-parent">
                              {t("board.childOf", { name: parentName })}
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          style={s.boardMiniBtn}
                          onClick={() => onUnarchive(plan.id)}
                        >
                          <ArchiveRestore size={10} strokeWidth={2} />
                          {t("board.unarchive")}
                        </button>
                        <button
                          type="button"
                          style={s.boardIconBtn}
                          title={t("board.preview")}
                          aria-label={t("board.preview")}
                          onClick={() => onPreview(plan)}
                        >
                          <BookOpenText size={11} strokeWidth={2} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
