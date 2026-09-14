/**
 * 方案看板（Plan Board）的纯状态派生。
 *
 * 阶段一只做「只读看板 + 生命周期管理 + 进度/依赖摘要展示」——本模块不含门禁与调度，
 * 所有函数都是 `plans` / `tasks` / `deps` 的纯派生，便于单测与复用（阶段二的
 * `evaluateTaskGate` 会在此基础上细化「等待」语义）。
 *
 * 关键口径：
 * - **进度**：某议题「完成」= 存在该议题的任务且 `status === "done"`；没有任务 = 未完成。
 * - **依赖摘要**：来自 `deps.json`，对**全局任务**解析（便于阶段三跨祖先方案引用）；
 *   `unmet` = 前置任务缺失或非 done。
 * - **归档**：`archivedAt` 非空即不占看板主列（AR1），但方案自身状态不变。
 */
import type { Plan, PlanIssue, PlanStatus, Task, TaskStatus } from "../types";
import type { PlanDeps } from "./planDeps";

/** 看板主列（= 生命周期）；`archivedAt` 非空的方案不落任何主列。 */
export type PlanBoardColumn = "draft" | "finalized" | "executing" | "completed" | "cancelled";

export const PLAN_BOARD_COLUMNS: readonly PlanBoardColumn[] = [
  "draft",
  "finalized",
  "executing",
  "completed",
  "cancelled",
];

const COLUMN_BY_STATUS: Record<PlanStatus, PlanBoardColumn> = {
  draft: "draft",
  finalized: "finalized",
  executing: "executing",
  completed: "completed",
  cancelled: "cancelled",
};

/** 已归档（展示层标记，与 status 正交）。 */
export function isPlanArchived(plan: Pick<Plan, "archivedAt">): boolean {
  return typeof plan.archivedAt === "number";
}

/** 方案应落在看板哪一列；已归档返回 null（移出主视图，进「已归档」区）。 */
export function planBoardColumn(plan: Plan): PlanBoardColumn | null {
  if (isPlanArchived(plan)) return null;
  return COLUMN_BY_STATUS[plan.status] ?? null;
}

/** 任务中的议题编号 → 任务（后出现者覆盖，与「同议题只生成一次」一致）。 */
export function buildTaskBySerial(tasks: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    const serial = task.yunxiaoSerialNumber?.trim();
    if (!serial) continue;
    map.set(serial, task);
  }
  return map;
}

/** 某方案下的议题 → 任务（按 `planId` 过滤，再按编号索引）。 */
export function tasksForPlan(
  plan: Pick<Plan, "id">,
  tasks: readonly Task[],
): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    if (task.planId !== plan.id) continue;
    const serial = task.yunxiaoSerialNumber?.trim();
    if (!serial) continue;
    map.set(serial, task);
  }
  return map;
}

export interface PlanIssueProgress {
  workitemId: string;
  serialNumber: string;
  subject: string;
  /** 承载该议题的任务 id；尚未生成待办时为 null。 */
  taskId: string | null;
  status: TaskStatus | null;
  done: boolean;
  /** 该议题的硬依赖编号（来自 deps.json；无依赖为空数组）。 */
  dependsOn: string[];
  /** 尚未满足的硬依赖编号（前置任务缺失或非 done）。 */
  unmet: string[];
}

export interface PlanProgress {
  issues: PlanIssueProgress[];
  total: number;
  done: number;
  /** 全部议题都已 done（没生成待办的议题算未完成）。 */
  allDone: boolean;
  /** 存在未满足前置的议题数。 */
  blockedIssues: number;
  /** 未满足的前置边总数（角标「等 N 项」）。 */
  unmetEdges: number;
  /** 没有任何议题生成过待办。 */
  noTasks: boolean;
}

/**
 * 派生方案进度与逐议题依赖摘要。
 *
 * `deps` 为已解析的 `deps.json`；缺省（文件缺失 / 未解析）时视为无依赖，只算进度。
 * 依赖解析使用**全局任务表**：阶段三的追加子方案引用祖先方案议题时无需改动此处。
 */
export function derivePlanProgress(
  plan: Pick<Plan, "id" | "issues">,
  tasks: readonly Task[],
  deps?: PlanDeps,
): PlanProgress {
  const ownTasks = tasksForPlan(plan, tasks);
  const globalBySerial = buildTaskBySerial(tasks);

  let done = 0;
  let blockedIssues = 0;
  let unmetEdges = 0;

  const issues = plan.issues.map((issue: PlanIssue): PlanIssueProgress => {
    const task = ownTasks.get(issue.serialNumber);
    const isDone = task?.status === "done";
    if (isDone) done += 1;

    const dependsOn = deps?.graph[issue.serialNumber] ?? [];
    const unmet = dependsOn.filter((dep) => {
      const depTask = globalBySerial.get(dep);
      return depTask?.status !== "done";
    });
    if (unmet.length > 0) {
      blockedIssues += 1;
      unmetEdges += unmet.length;
    }

    return {
      workitemId: issue.workitemId,
      serialNumber: issue.serialNumber,
      subject: issue.subject,
      taskId: task?.id ?? null,
      status: task?.status ?? null,
      done: Boolean(isDone),
      dependsOn: [...dependsOn],
      unmet,
    };
  });

  return {
    issues,
    total: plan.issues.length,
    done,
    allDone: plan.issues.length > 0 && done === plan.issues.length,
    blockedIssues,
    unmetEdges,
    noTasks: ownTasks.size === 0,
  };
}

export interface PlanLifecycleActions {
  /** 标记完成：定稿或执行中 → completed。 */
  canComplete: boolean;
  /** 重开：completed → executing。 */
  canReopen: boolean;
  /** 取消（留存态，不删记录）：非 cancelled 且未归档。 */
  canCancel: boolean;
  /** 归档：已完成且未归档（移出看板主视图）。 */
  canArchive: boolean;
  /** 反归档：已归档。 */
  canUnarchive: boolean;
  /** 显式删除：任何状态都允许（危险操作，UI 需二次确认）。 */
  canDelete: boolean;
}

/**
 * 生命周期动作可用性集中判定，UI 只读此结果——避免各处散落 `status === ...` 判断。
 * 依据决策：M1 完成手动、可重开；F1 取消为留存态；AR1 归档是展示层动作。
 */
export function planLifecycleActions(plan: Pick<Plan, "status" | "archivedAt">): PlanLifecycleActions {
  const archived = isPlanArchived(plan);
  return {
    canComplete: !archived && (plan.status === "finalized" || plan.status === "executing"),
    canReopen: !archived && plan.status === "completed",
    canCancel: !archived && plan.status !== "cancelled",
    canArchive: !archived && plan.status === "completed",
    canUnarchive: archived,
    canDelete: true,
  };
}

export interface PlanBoardGroup {
  projectId: string;
  /** 每个主列的方案（已按 createdAt 升序）。 */
  columns: Record<PlanBoardColumn, Plan[]>;
  /** 已归档方案（按归档时间倒序）。 */
  archived: Plan[];
  /** 主列上的方案总数（不含归档）。 */
  activeCount: number;
  /** 全部方案数（含归档）。 */
  totalCount: number;
}

function byCreatedAtAsc(a: Plan, b: Plan): number {
  return a.createdAt - b.createdAt;
}

function byArchivedAtDesc(a: Plan, b: Plan): number {
  return (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt);
}

/**
 * 把方案按项目分组、按生命周期入列（决策 S1：跨项目总览）。
 * 组顺序：主列方案数倒序，其次 projectId —— 与任务看板「活跃多的在上」一致，结果确定。
 */
export function groupPlansForBoard(plans: readonly Plan[]): PlanBoardGroup[] {
  const byProject = new Map<string, PlanBoardGroup>();
  for (const plan of plans) {
    let group = byProject.get(plan.projectId);
    if (!group) {
      group = {
        projectId: plan.projectId,
        columns: { draft: [], finalized: [], executing: [], completed: [], cancelled: [] },
        archived: [],
        activeCount: 0,
        totalCount: 0,
      };
      byProject.set(plan.projectId, group);
    }
    group.totalCount += 1;
    const column = planBoardColumn(plan);
    if (column === null) {
      group.archived.push(plan);
      continue;
    }
    group.columns[column].push(plan);
    group.activeCount += 1;
  }

  for (const group of byProject.values()) {
    for (const column of PLAN_BOARD_COLUMNS) group.columns[column].sort(byCreatedAtAsc);
    group.archived.sort(byArchivedAtDesc);
  }

  return Array.from(byProject.values()).sort((a, b) => {
    if (a.activeCount !== b.activeCount) return b.activeCount - a.activeCount;
    return a.projectId.localeCompare(b.projectId);
  });
}
