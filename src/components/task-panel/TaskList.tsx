import { useCallback, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Plus } from "lucide-react";
import type { BranchBatch, Task, TaskDisplayWindow } from "../../types";
import { TaskListItem } from "./TaskListItem";
import { useI18n } from "../../i18n";
import s from "../../styles";

const GROUP_ROW_HEIGHT = 27;
const TASK_ROW_HEIGHT = 47;
const OVERSCAN_ROWS = 8;

type VirtualRow =
  | { type: "group"; key: string; label: string; height: number }
  | { type: "task"; key: string; task: Task; showRunTodo: boolean; height: number };

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
  onCreateTaskInGroup,
}: {
  tasks: Task[];
  taskDisplayWindow: TaskDisplayWindow;
  query: string;
  selectedId: string | null;
  isNewTask: boolean;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onToggleTaskStar: (id: string) => void;
  onRunTodo: (task: Task) => void;
  batches: BranchBatch[];
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

  const rows = useMemo<VirtualRow[]>(() => {
    const MAIN = "__main__";
    const attention: Task[] = [];
    const groups = new Map<string, { label: string; tasks: Task[] }>();
    // 批创建时在 batch.taskIds 记录成员，任务自身未写 batchId——用 task.id → 所属批 来归组。
    const taskToBatch = new Map<string, BranchBatch>();
    for (const b of batches) {
      for (const tid of b.taskIds ?? []) taskToBatch.set(tid, b);
    }
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
      const batch = taskToBatch.get(task.id);
      let key: string;
      let label: string;
      if (isWorktree) {
        key = `wt:${task.worktreePath}`;
        label = `WorkTree · ${task.worktreeBranch ?? "?"}`;
      } else if (batch) {
        key = `batch:${batch.id}`;
        label = `WorkTree · ${batch.branch}`;
      } else {
        key = MAIN;
        label = "主检出";
      }
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { label, tasks: [] }));
      g.tasks.push(task);
    }

    const nextRows: VirtualRow[] = [];
    const appendGroup = (key: string, label: string, groupTasks: Task[]) => {
      if (groupTasks.length === 0) return;
      nextRows.push({ type: "group", key, label, height: GROUP_ROW_HEIGHT });
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
  }, [sorted, t, taskDisplayWindow, batches]);

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
                <div style={s.groupRow}>
                  <span style={s.groupLabel}>{row.label}</span>
                  <button
                    type="button"
                    style={s.groupAdd}
                    aria-label="新建任务"
                    title="新建任务"
                    onClick={() => onCreateTaskInGroup(row.key)}
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
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
