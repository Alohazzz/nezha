/**
 * 方案看板的纯状态派生（**任务为主体**）。
 *
 * 看板的重心是「方案里每个任务的状态 / 前置约束 / 运行情况」，方案本身退为分组表头。
 * 本模块不含门禁与调度，只把 `plans` / `tasks` / `deps` 派生为可渲染的行。
 *
 * 关键口径：
 * - **进度**：某议题「完成」= 存在该议题的任务且 `status === "done"`；没有任务 = 未完成。
 * - **前置约束**：来自 `deps.json`，对**全局任务**解析（阶段三跨祖先方案引用无需改动）。
 * - **归档**：`archivedAt` 非空即不占看板主视图（AR1），但方案自身状态不变。
 */
import type { Plan, PlanIssue, PlanStatus, Task, TaskStatus } from "../types";
import type { PlanDeps } from "./planDeps";
import { topoSortPlanIssues } from "./planDeps";

/** 已归档（展示层标记，与 status 正交）。 */
export function isPlanArchived(plan: Pick<Plan, "archivedAt">): boolean {
  return typeof plan.archivedAt === "number";
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
export function tasksForPlan(plan: Pick<Plan, "id">, tasks: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    if (task.planId !== plan.id) continue;
    const serial = task.yunxiaoSerialNumber?.trim();
    if (!serial) continue;
    map.set(serial, task);
  }
  return map;
}

/** 看板主体的一行 = 一个方案议题 + 其任务。 */
export interface PlanTaskRow {
  workitemId: string;
  serialNumber: string;
  subject: string;
  /** 承载该议题的任务；尚未生成待办时为 null。 */
  task: Task | null;
  status: TaskStatus | null;
  /** 状态最近变更时间（`updatedAt ?? createdAt`）；用于「已运行 / 已等待 X」。 */
  statusSince: number | null;
  /** 该议题的硬依赖编号（来自 deps.json；无依赖为空数组）。 */
  dependsOn: string[];
  /** 尚未满足的硬依赖编号（前置任务缺失或非 done）。 */
  unmet: string[];
  /** 存在异常/缺失前置，需要人工决定是否越过。 */
  needsOverride: boolean;
}

export interface PlanTaskRows {
  rows: PlanTaskRow[];
  total: number;
  done: number;
  /** 全部议题都已 done（没生成待办的议题算未完成）。 */
  allDone: boolean;
  /** 未满足的前置边总数（表头「等 N 项」）。 */
  unmetEdges: number;
  /** 没有任何议题生成过待办。 */
  noTasks: boolean;
  /** 有任务处于活跃态（运行中 / 待介入）——用于「这个方案正在干活」标记。 */
  runningCount: number;
}

/** 某任务是否属「正在干活」（占并发槽位、界面需要突出）。 */
function isRunningStatus(status: TaskStatus): boolean {
  return (
    status === "running" ||
    status === "pending" ||
    status === "input_required" ||
    status === "awaiting_review"
  );
}

/** 前置是否算异常/缺失（等待任务需要人工越过）。 */
function depNeedsOverride(depTask: Task | undefined): boolean {
  if (!depTask) return true;
  return (
    depTask.status === "failed" ||
    depTask.status === "cancelled" ||
    depTask.status === "interrupted"
  );
}

/**
 * 把一个方案的议题派生为任务行，**按建议执行顺序（拓扑序）排列**——这样看板读下来
 * 就是实际接续顺序。`deps` 缺省（文件缺失 / 未解析）时视为无依赖，只算进度。
 */
export function derivePlanTaskRows(
  plan: Pick<Plan, "id" | "issues">,
  tasks: readonly Task[],
  deps?: PlanDeps,
): PlanTaskRows {
  const ownTasks = tasksForPlan(plan, tasks);
  const globalBySerial = buildTaskBySerial(tasks);
  const serials = plan.issues.map((issue) => issue.serialNumber);
  const issueBySerial = new Map<string, PlanIssue>(plan.issues.map((i) => [i.serialNumber, i]));

  // 拓扑序排列（无 deps 时按 plan.issues 给定顺序），保证「接续顺序」可读。
  const orderedSerials = deps
    ? topoSortPlanIssues(serials, deps.graph, deps.executionOrder)
    : serials;

  let done = 0;
  let unmetEdges = 0;
  let runningCount = 0;

  const rows: PlanTaskRow[] = [];
  for (const serial of orderedSerials) {
    const issue = issueBySerial.get(serial);
    if (!issue) continue;
    const task = ownTasks.get(serial) ?? null;
    const status = task?.status ?? null;
    const isDone = status === "done";
    if (isDone) done += 1;
    if (status && isRunningStatus(status)) runningCount += 1;

    const dependsOn = deps?.graph[serial] ?? [];
    const unmet = dependsOn.filter((dep) => globalBySerial.get(dep)?.status !== "done");
    unmetEdges += unmet.length;
    const needsOverride = unmet.some((dep) => depNeedsOverride(globalBySerial.get(dep)));

    rows.push({
      workitemId: issue.workitemId,
      serialNumber: serial,
      subject: issue.subject,
      task,
      status,
      statusSince: task ? (task.updatedAt ?? task.createdAt) : null,
      dependsOn: [...dependsOn],
      unmet,
      needsOverride,
    });
  }

  return {
    rows,
    total: plan.issues.length,
    done,
    allDone: plan.issues.length > 0 && done === plan.issues.length,
    unmetEdges,
    noTasks: ownTasks.size === 0,
    runningCount,
  };
}

/** 已满足的前置编号（供 Checklist / 前置展示区分「已完成」与「等待中」）。 */
export function satisfiedDependencies(row: PlanTaskRow, tasks: readonly Task[]): string[] {
  const bySerial = buildTaskBySerial(tasks);
  const unmetSet = new Set(row.unmet);
  return row.dependsOn.filter((dep) => !unmetSet.has(dep) && bySerial.has(dep));
}

export interface PlanLifecycleActions {
  /** 标记完成：执行中 → completed。 */
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
 *
 * 「标记完成」只对**执行中**开放：完成意味着「方案计划的工作已做完」，而 `finalized`
 * 尚未生成待办、`draft` 还在讨论，想收尾应走「取消」而非「完成」。
 */
export function planLifecycleActions(
  plan: Pick<Plan, "status" | "archivedAt">,
): PlanLifecycleActions {
  const archived = isPlanArchived(plan);
  return {
    canComplete: !archived && plan.status === "executing",
    canReopen: !archived && plan.status === "completed",
    canCancel: !archived && plan.status !== "cancelled",
    canArchive: !archived && plan.status === "completed",
    canUnarchive: archived,
    canDelete: true,
  };
}

export interface PlanBoardProjectGroup {
  projectId: string;
  /** 该项目的活跃方案（未归档），按 createdAt 升序。 */
  plans: Plan[];
  /** 该项目的已归档方案，按归档时间倒序。 */
  archived: Plan[];
  /** 活跃方案里含未完成任务的数量（表头「N 进行中」）。 */
  activePlanCount: number;
}

/**
 * 按项目分组（决策 S1：跨项目总览）。组顺序：活跃方案数倒序，其次 projectId ——
 * 与任务看板「活跃多的在上」一致，结果确定。
 */
export function groupPlansByProject(
  plans: readonly Plan[],
  /** 「有任务在动」的方案 id（在跑 / 等待 / 异常）——组内优先，并计入活跃数。 */
  livelyPlanIds: ReadonlySet<string>,
): PlanBoardProjectGroup[] {
  const byProject = new Map<string, PlanBoardProjectGroup>();
  for (const plan of plans) {
    let group = byProject.get(plan.projectId);
    if (!group) {
      group = { projectId: plan.projectId, plans: [], archived: [], activePlanCount: 0 };
      byProject.set(plan.projectId, group);
    }
    if (isPlanArchived(plan)) {
      group.archived.push(plan);
      continue;
    }
    group.plans.push(plan);
    // 「活跃」= 有任务在动，或还没到终态（draft/finalized/executing）。
    if (livelyPlanIds.has(plan.id) || plan.status !== "completed") {
      group.activePlanCount += 1;
    }
  }

  for (const group of byProject.values()) {
    // 组内排序：**有任务在动的方案优先**（看板重心是任务），再按 createdAt 升序。
    group.plans.sort((a, b) => {
      const aLively = livelyPlanIds.has(a.id) ? 0 : 1;
      const bLively = livelyPlanIds.has(b.id) ? 0 : 1;
      if (aLively !== bLively) return aLively - bLively;
      return a.createdAt - b.createdAt;
    });
    group.archived.sort((a, b) => (b.archivedAt ?? b.createdAt) - (a.archivedAt ?? a.createdAt));
  }

  return Array.from(byProject.values()).sort((a, b) => {
    if (a.activePlanCount !== b.activePlanCount) return b.activePlanCount - a.activePlanCount;
    return a.projectId.localeCompare(b.projectId);
  });
}

/** 方案议题编号 → 议题（Checklist 展示用）。 */
export function planIssueSubjects(plan: Plan | null | undefined): Map<string, PlanIssue> {
  const map = new Map<string, PlanIssue>();
  for (const issue of plan?.issues ?? []) map.set(issue.serialNumber, issue);
  return map;
}

/** 生命周期列顺序（供筛选 chips / 徽章复用）。 */
export const PLAN_STATUS_ORDER: readonly PlanStatus[] = [
  "draft",
  "finalized",
  "executing",
  "completed",
  "cancelled",
];
