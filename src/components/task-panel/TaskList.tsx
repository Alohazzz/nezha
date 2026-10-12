import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ChevronDown, Plus } from "lucide-react";
import type { DeliveryPlan, Task, TaskDisplayWindow } from "../../types";
import type { PlanWaitingBadge } from "../../utils/planQueue";
import { load, save } from "../../utils";
import { TaskListItem } from "./TaskListItem";
import { useI18n } from "../../i18n";
import s from "../../styles";

const GROUP_ROW_HEIGHT = 27;
const TASK_ROW_HEIGHT = 47;
const OVERSCAN_ROWS = 8;

type VirtualRow =
  | { type: "group"; key: string; label: string; count: number; collapsed: boolean; height: number }
  | { type: "task"; key: string; task: Task; showRunTodo: boolean; height: number };

function collapsedGroupsKey(projectId: string) {
  return `nezha.collapsedGroups.${projectId}`;
}

/** 组 key 里有 worktree 路径 / 计划 id，组消失后残留 key 在每次保存时惰性清掉。 */
function loadCollapsedGroups(projectId: string, knownKeys: Set<string>): Set<string> {
  const stored = load<string[]>(collapsedGroupsKey(projectId), []);
  return new Set(stored.filter((key) => knownKeys.has(key)));
}

function findRowIndex(offsets: number[], value: number) {
  if (offsets.length <= 1) return 0;

  let low = 0;
  let high = offsets.length - 2;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid + 1] < value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

export function TaskList({
  projectId,
  tasks,
  taskDisplayWindow,
  query,
  selectedId,
  isNewTask,
  onSelectTask,
  onDeleteTask,
  onToggleTaskStar,
  onRunTodo,
  batches,
  waitingBadges,
  onCreateTaskInGroup,
}: {
  projectId: string;
  tasks: Task[];
  taskDisplayWindow: TaskDisplayWindow;
  query: string;
  selectedId: string | null;
  isNewTask: boolean;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onToggleTaskStar: (id: string) => void;
  onRunTodo: (task: Task) => void;
  batches: DeliveryPlan[];
  /** 方案待办的等待角标（taskId → 角标信息）；非等待态任务不在表内。 */
  waitingBadges?: Map<string, PlanWaitingBadge>;
  onCreateTaskInGroup: (groupKey: string) => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateViewportHeight = () => setViewportHeight(el.clientHeight);
    updateViewportHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateViewportHeight);
      return () => window.removeEventListener("resize", updateViewportHeight);
    }

    const resizeObserver = new ResizeObserver(updateViewportHeight);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
  }, []);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  const filtered = useMemo(() => {
    if (!query.trim()) return tasks;
    const q = query.toLowerCase();
    return tasks.filter((t) => t.prompt.toLowerCase().includes(q));
  }, [tasks, query]);

  const sorted = useMemo(() => {
    const sortKey = (task: Task) => task.updatedAt ?? task.createdAt;
    return [...filtered].sort((a, b) => {
      const aNeedsAttention =
        a.status === "input_required" ||
        a.status === "awaiting_review" ||
        a.status === "detached" ||
        a.status === "interrupted";
      const bNeedsAttention =
        b.status === "input_required" ||
        b.status === "awaiting_review" ||
        b.status === "detached" ||
        b.status === "interrupted";
      if (aNeedsAttention && !bNeedsAttention) return -1;
      if (!aNeedsAttention && bNeedsAttention) return 1;
      if (aNeedsAttention && bNeedsAttention) {
        return (b.attentionRequestedAt ?? sortKey(b)) - (a.attentionRequestedAt ?? sortKey(a));
      }
      return sortKey(b) - sortKey(a);
    });
  }, [filtered]);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // 现存组 key 集合：用于 localStorage 加载时的惰性清理，见 rows 构建处。
  const existingGroupKeys = useMemo(() => {
    const MAIN = "__main__";
    const planById = new Map<string, DeliveryPlan>();
    for (const b of batches) planById.set(b.id, b);
    const keys = new Set<string>([MAIN, "attention"]);
    for (const task of sorted) {
      if (!!task.worktreePath && !task.worktreeDiscarded) {
        keys.add(`wt:${task.worktreePath}`);
      } else if (task.deliveryPlanId && planById.has(task.deliveryPlanId)) {
        keys.add(`batch:${task.deliveryPlanId}`);
      }
    }
    return keys;
  }, [sorted, batches]);

  // 折叠状态按项目持久化；项目切换时重新加载。
  useEffect(() => {
    setCollapsedGroups(loadCollapsedGroups(projectId, existingGroupKeys));
  }, [projectId, existingGroupKeys]);

  const toggleGroup = useCallback(
    (key: string) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        // 保存前清理已消失的组 key，避免残留死数据无限累积。
        const persisted = [...next].filter((k) => existingGroupKeys.has(k));
        save(collapsedGroupsKey(projectId), persisted);
        return next;
      });
    },
    [projectId, existingGroupKeys],
  );

  // 选中导航例外：selectedId 落进折叠组时展开该组一次（reveal）。
  useEffect(() => {
    if (!selectedId) return;
    const task = tasks.find((t) => t.id === selectedId);
    if (!task) return;
    const planById = new Map<string, DeliveryPlan>();
    for (const b of batches) planById.set(b.id, b);
    const needsAttention =
      task.status === "input_required" ||
      task.status === "awaiting_review" ||
      task.status === "detached" ||
      task.status === "interrupted";
    const key = needsAttention
      ? "attention"
      : !!task.worktreePath && !task.worktreeDiscarded
        ? `wt:${task.worktreePath}`
        : task.deliveryPlanId && planById.has(task.deliveryPlanId)
          ? `batch:${task.deliveryPlanId}`
          : "__main__";
    setCollapsedGroups((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [selectedId, tasks, batches]);

  const rows = useMemo<VirtualRow[]>(() => {
    const MAIN = "__main__";
    const attention: Task[] = [];
    const groups = new Map<string, { label: string; tasks: Task[] }>();
    // 任务经 deliveryPlanId 绑定计划（迁移已回写遗留成员），据此归组。
    const planById = new Map<string, DeliveryPlan>();
    for (const b of batches) planById.set(b.id, b);
    const cutoff =
      taskDisplayWindow === "all"
        ? Number.NEGATIVE_INFINITY
        : Date.now() - taskDisplayWindow * 24 * 60 * 60 * 1000;

    for (const task of sorted) {
      const needsAttention =
        task.status === "input_required" ||
        task.status === "awaiting_review" ||
        task.status === "detached" ||
        task.status === "interrupted";
      if (needsAttention) {
        attention.push(task);
        continue;
      }
      const bucketAt = task.updatedAt ?? task.createdAt;
      if (bucketAt < cutoff) continue;
      const isWorktree = !!task.worktreePath && !task.worktreeDiscarded;
      const batch = task.deliveryPlanId ? planById.get(task.deliveryPlanId) : undefined;
      let key: string;
      let label: string;
      if (isWorktree) {
        key = `wt:${task.worktreePath}`;
        label = `WorkTree · ${task.worktreeBranch ?? "?"}`;
      } else if (batch) {
        key = `batch:${batch.id}`;
        label = `计划 · ${batch.name}`;
      } else {
        key = MAIN;
        label = "主检出";
      }
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { label, tasks: [] }));
      g.tasks.push(task);
    }

    // 搜索语义是"找出所有匹配项"，query 非空时忽略折叠强制展开。
    const searching = !!query.trim();

    const nextRows: VirtualRow[] = [];
    const appendGroup = (key: string, label: string, groupTasks: Task[]) => {
      if (groupTasks.length === 0) return;
      const collapsed = !searching && collapsedGroups.has(key);
      nextRows.push({ type: "group", key, label, count: groupTasks.length, collapsed, height: GROUP_ROW_HEIGHT });
      if (collapsed) return;
      groupTasks.forEach((task) => {
        nextRows.push({
          type: "task",
          key: task.id,
          task,
          showRunTodo: task.status === "todo",
          height: TASK_ROW_HEIGHT,
        });
      });
    };

    if (attention.length) appendGroup("attention", t("task.needsAttention"), attention);
    // 主检出（无 worktree）作为基准放最前，其后各 worktree 按最旧组先显示。
    const mainGroup = groups.get(MAIN);
    if (mainGroup) appendGroup(MAIN, mainGroup.label, mainGroup.tasks);
    [...groups.entries()]
      .filter(([key]) => key !== MAIN)
      .forEach(([key, g]) => appendGroup(key, g.label, g.tasks));

    return nextRows;
  }, [sorted, t, taskDisplayWindow, batches, query, collapsedGroups]);

  const offsets = useMemo(() => {
    const nextOffsets = [0];
    for (const row of rows) {
      nextOffsets.push(nextOffsets[nextOffsets.length - 1] + row.height);
    }
    return nextOffsets;
  }, [rows]);

  const totalHeight = offsets[offsets.length - 1] ?? 0;
  const startIndex = Math.max(0, findRowIndex(offsets, scrollTop) - OVERSCAN_ROWS);
  const endIndex = Math.min(
    rows.length,
    findRowIndex(offsets, scrollTop + viewportHeight) + OVERSCAN_ROWS + 1,
  );
  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div ref={scrollRef} style={s.taskListScroll} onScroll={handleScroll}>
      {tasks.length === 0 && <div style={s.taskListEmpty}>{t("task.noTasksYet")}</div>}
      <div style={{ height: totalHeight, position: "relative" }}>
        {visibleRows.map((row, visibleIndex) => {
          const rowIndex = startIndex + visibleIndex;
          const top = offsets[rowIndex] ?? 0;

          return (
            <div
              key={row.key}
              style={{
                position: "absolute",
                top,
                left: 0,
                right: 0,
                height: row.height,
                overflow: "hidden",
              }}
            >
              {row.type === "group" ? (
                <div
                  className="tasklist-group-row"
                  data-collapsed={row.collapsed}
                  style={s.groupRow}
                  role="button"
                  tabIndex={0}
                  aria-expanded={!row.collapsed}
                  onClick={() => toggleGroup(row.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleGroup(row.key);
                    }
                  }}
                >
                  <span className="tasklist-group-chevron">
                    <ChevronDown size={12} />
                  </span>
                  <span style={s.groupLabel} className="tasklist-group-label">
                    {row.label}
                  </span>
                  <span className="tasklist-group-count">{row.count}</span>
                  <button
                    type="button"
                    style={s.groupAdd}
                    aria-label={t("task.newTask")}
                    title={t("task.newTask")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreateTaskInGroup(row.key);
                    }}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              ) : (
                <TaskListItem
                  task={row.task}
                  selected={selectedId === row.task.id && !isNewTask}
                  onClick={() => onSelectTask(row.task.id)}
                  onDelete={() => onDeleteTask(row.task.id)}
                  onToggleStar={() => onToggleTaskStar(row.task.id)}
                  onRunTodo={row.showRunTodo ? () => onRunTodo(row.task) : undefined}
                  waitingBadgeKind={waitingBadges?.get(row.task.id)?.kind}
                  waitingBadgeCount={waitingBadges?.get(row.task.id)?.count}
                  waitingBadgeBlocked={waitingBadges?.get(row.task.id)?.blocked}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
