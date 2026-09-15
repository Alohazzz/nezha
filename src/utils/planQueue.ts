/**
 * 方案待办的依赖门禁与串行队列（纯状态派生）。
 *
 * 设计约束（见 issue #85 的关键取舍）：依赖只存在 `deps.json` 里，运行时不读盘——
 * 本模块的一切输入都是内存里的 `Task[]` + 已解析的 `PlanDeps`，「前置是否满足」由
 * 任务自身状态派生。调度（谁该启动）也只返回 id 列表，不触碰 IO / Tauri。
 *
 * 术语：
 * - **满足** = 前置任务 `status === "done"`（共享工作区下「产物已可见」就是依赖满足）；
 * - **异常/缺失** = 前置是 failed/cancelled/interrupted，或该议题根本没有任务
 *   （被删除 / 生成时被剔除）——不自静默放行，交由用户决定是否越过；
 * - **槽位** = 项目级并发上限（默认 1，串行）；前置全部满足但无槽位时任务排队等待。
 */
import type { Plan, PlanIssue, Task, TaskStatus } from "../types";
import { isActiveTaskStatus } from "../types";
import { topoSortPlanIssues, type PlanDeps, type PlanDepGraph } from "./planDeps";

/** 单条前置的当前状态：null 表示已满足。 */
export type PlanDepBlocker = "pending" | "abnormal" | "missing" | null;

export interface PlanDepEntry {
  serialNumber: string;
  blocker: PlanDepBlocker;
  /** 前置任务 id（议题缺任务时为 undefined）。 */
  taskId?: string;
  /** 前置任务当前状态（议题缺任务时为 undefined）。 */
  status?: TaskStatus;
}

export interface PlanTaskGate {
  /** 直接硬依赖，保持 deps.json 内的顺序。 */
  entries: PlanDepEntry[];
  /** 尚未完成的前置编号（含异常/缺失）。 */
  unmet: string[];
  /** 异常或缺失、需要人工决定是否越过的前置编号。 */
  needsOverride: string[];
  /** 存在任一未完成前置即 true。 */
  blocked: boolean;
}

/** 任务列表行 / 详情页用的等待角标信息。 */
export interface PlanWaitingBadge {
  /** deps = 还在等前置；slot = 前置已满足、在排队等并发槽位。 */
  kind: "deps" | "slot";
  /** 等待中的前置数量（slot 恒为 0）。 */
  count: number;
  /** 存在异常/缺失前置（UI 标红）。 */
  blocked: boolean;
}

export function isDependencySatisfied(status: TaskStatus | undefined): boolean {
  return status === "done";
}

export function isDependencyAbnormal(status: TaskStatus | undefined): boolean {
  return status === "failed" || status === "cancelled" || status === "interrupted";
}

/** 议题编号 → 承载该议题的任务（后出现的覆盖先出现的，与「同议题只生成一次」一致）。 */
export function buildTaskBySerial(tasks: readonly Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const task of tasks) {
    const serial = task.yunxiaoSerialNumber?.trim();
    if (!serial) continue;
    map.set(serial, task);
  }
  return map;
}

/** 评估某议题的硬依赖是否已满足。`graph` 无该议题键时视为无依赖。 */
export function evaluateTaskGate(
  serialNumber: string,
  graph: PlanDepGraph,
  taskBySerial: ReadonlyMap<string, Task>,
): PlanTaskGate {
  const serial = serialNumber.trim();
  const depSerials = serial ? (graph[serial] ?? []) : [];
  const entries: PlanDepEntry[] = depSerials.map((dep) => {
    const task = taskBySerial.get(dep);
    if (!task) {
      return { serialNumber: dep, blocker: "missing" as const };
    }
    if (isDependencySatisfied(task.status)) {
      return { serialNumber: dep, blocker: null, taskId: task.id, status: task.status };
    }
    return {
      serialNumber: dep,
      blocker: isDependencyAbnormal(task.status) ? ("abnormal" as const) : ("pending" as const),
      taskId: task.id,
      status: task.status,
    };
  });
  const unmet = entries.filter((e) => e.blocker !== null).map((e) => e.serialNumber);
  return {
    entries,
    unmet,
    needsOverride: entries
      .filter((e) => e.blocker === "abnormal" || e.blocker === "missing")
      .map((e) => e.serialNumber),
    blocked: unmet.length > 0,
  };
}

/** 项目内占用并发槽位的任务数（活跃 agent 任务；等待态不占槽）。 */
export function countOccupiedSlots(tasks: readonly Task[], projectId: string): number {
  let count = 0;
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (isActiveTaskStatus(task.status)) count += 1;
  }
  return count;
}

/** 列出本项目仍占用槽位的任务（供「排队原因」展示：谁在跑）。 */
export function activeTasksInProject(tasks: readonly Task[], projectId: string): Task[] {
  return tasks.filter((task) => task.projectId === projectId && isActiveTaskStatus(task.status));
}

function planRankMap(
  plan: Plan | undefined,
  deps: PlanDeps | undefined,
): Map<string, number> {
  const serials = plan?.issues.map((issue) => issue.serialNumber) ?? [];
  const ordered =
    deps !== undefined
      ? topoSortPlanIssues(serials, deps.graph, deps.executionOrder)
      : topoSortPlanIssues(serials, {});
  const rank = new Map<string, number>();
  ordered.forEach((serial, index) => rank.set(serial, index));
  return rank;
}

/**
 * 等待队列的确定性顺序：拓扑序 → executionOrder → createdAt 升序 → id。
 * 入参是「前置已全部满足、只因缺少并发槽位而排队」的任务。
 */
export function orderWaitingQueue(
  tasks: readonly Task[],
  planById: ReadonlyMap<string, Plan>,
  depsByPlanId: Readonly<Record<string, PlanDeps | undefined>>,
): Task[] {
  const rankByPlan = new Map<string, Map<string, number>>();
  const rankOf = (task: Task): number => {
    if (!task.planId) return Number.MAX_SAFE_INTEGER;
    let rank = rankByPlan.get(task.planId);
    if (!rank) {
      rank = planRankMap(planById.get(task.planId), depsByPlanId[task.planId]);
      rankByPlan.set(task.planId, rank);
    }
    return rank.get(task.yunxiaoSerialNumber ?? "") ?? Number.MAX_SAFE_INTEGER;
  };
  return [...tasks].sort((a, b) => {
    const ra = rankOf(a);
    const rb = rankOf(b);
    if (ra !== rb) return ra - rb;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
}

export interface AutoStartInput {
  tasks: readonly Task[];
  depsByPlanId: Readonly<Record<string, PlanDeps | undefined>>;
  planById: ReadonlyMap<string, Plan>;
  /** 项目级并发上限（未配置时用 defaultMaxConcurrent）。 */
  maxConcurrentByProjectId: Readonly<Record<string, number | undefined>>;
  defaultMaxConcurrent: number;
}

/**
 * 选出本轮应当自动启动的等待任务 id（按接续顺序）。
 *
 * 只挑选「前置已全部满足（或用户已明确忽略依赖）」的 `waiting_deps` 任务，并按项目
 * 的空闲槽位截断——同一批被同一前置解锁的任务因此只会按顺序逐个放行，默认串行。
 */
export function selectAutoStart(input: AutoStartInput): string[] {
  const { tasks, depsByPlanId, planById, maxConcurrentByProjectId, defaultMaxConcurrent } = input;
  const taskBySerial = buildTaskBySerial(tasks);
  const waitingByProject = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.status !== "waiting_deps") continue;
    const bucket = waitingByProject.get(task.projectId);
    if (bucket) bucket.push(task);
    else waitingByProject.set(task.projectId, [task]);
  }

  const started: string[] = [];
  for (const [projectId, waiting] of waitingByProject) {
    const configured = maxConcurrentByProjectId[projectId];
    const maxConcurrent =
      typeof configured === "number" && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : defaultMaxConcurrent;
    const slots = Math.max(0, maxConcurrent - countOccupiedSlots(tasks, projectId));
    if (slots === 0) continue;

    const startable = waiting.filter((task) => {
      if (task.planDepsIgnored) return true;
      const deps = task.planId ? depsByPlanId[task.planId] : undefined;
      if (!deps) return true;
      return !evaluateTaskGate(task.yunxiaoSerialNumber ?? "", deps.graph, taskBySerial).blocked;
    });
    if (startable.length === 0) continue;

    started.push(...orderWaitingQueue(startable, planById, depsByPlanId).slice(0, slots).map((t) => t.id));
  }
  return started;
}

/**
 * 为 `waiting_deps` 任务派生行内角标信息（列表行只吃 primitive，避免破坏 memo）。
 * 非等待态返回 undefined。
 */
export function buildWaitingBadges(
  tasks: readonly Task[],
  depsByPlanId: Readonly<Record<string, PlanDeps | undefined>>,
): Map<string, PlanWaitingBadge> {
  const taskBySerial = buildTaskBySerial(tasks);
  const badges = new Map<string, PlanWaitingBadge>();
  for (const task of tasks) {
    if (task.status !== "waiting_deps") continue;
    const deps = task.planId ? depsByPlanId[task.planId] : undefined;
    const gate = deps
      ? evaluateTaskGate(task.yunxiaoSerialNumber ?? "", deps.graph, taskBySerial)
      : { unmet: [], needsOverride: [], blocked: false, entries: [] };
    if (gate.unmet.length > 0) {
      badges.set(task.id, {
        kind: "deps",
        count: gate.unmet.length,
        blocked: gate.needsOverride.length > 0,
      });
    } else {
      badges.set(task.id, { kind: "slot", count: 0, blocked: false });
    }
  }
  return badges;
}

/** 方案议题编号 → 标题（Checklist 展示用）。 */
export function planIssueSubjects(plan: Plan | null | undefined): Map<string, PlanIssue> {
  const map = new Map<string, PlanIssue>();
  for (const issue of plan?.issues ?? []) map.set(issue.serialNumber, issue);
  return map;
}
