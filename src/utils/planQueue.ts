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
 *   槽位按**方案分池**：方案待办只与同方案（同 planId）的活跃任务互斥，不同方案
 *   可并行（各自任务以独立 worktree 启动，不共享工作区）；无 planId 的普通任务
 *   与手工任务共享项目池——它们落在项目主工作区，必须与一切互斥。
 */
import type { PermissionMode, Plan, PlanIssue, Task, TaskStatus } from "../types";
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
  /** deps = 还在等前置；slot = 前置已满足、在排队等并发槽位；loading = 依赖尚未载入。 */
  kind: "deps" | "slot" | "loading";
  /** 等待中的前置数量（slot / loading 恒为 0）。 */
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

/**
 * 任务占用的槽位池键：方案待办按「项目 + 方案」分池，普通任务（无 planId）落
 * 项目公共池（键即 projectId）。普通任务跑在项目主工作区，须与一切任务互斥。
 */
function slotPoolKey(task: Pick<Task, "projectId" | "planId">): string {
  return task.planId ? `${task.projectId}::${task.planId}` : task.projectId;
}

/**
 * 指定槽位池内占用槽位的任务数（活跃 agent 任务；等待态不占槽）。
 * `planId` 为 undefined 时统计项目公共池（含所有普通任务）；有 planId 时只统计
 * 同方案任务——不同方案彼此不占槽，可并行。
 */
export function countOccupiedSlots(
  tasks: readonly Task[],
  projectId: string,
  planId?: string,
): number {
  let count = 0;
  const pool = planId ? `${projectId}::${planId}` : projectId;
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (!isActiveTaskStatus(task.status)) continue;
    if (slotPoolKey(task) !== pool) continue;
    count += 1;
  }
  return count;
}

/** 生效的并发上限：配置值非法（缺失 / 非正 / 非有限）时回落默认值。 */
export function resolveMaxConcurrent(
  configured: number | undefined,
  defaultMaxConcurrent: number,
): number {
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : defaultMaxConcurrent;
}

/**
 * 该槽位池当前是否还有空闲并发槽位。
 *
 * 手动启动路径（`handleRunTodoTask`）与自动接续共用同一判定，否则串行守卫
 * 会被手动 ▶ / 「忽略依赖仍开始」绕过（决策 L1：守卫须放在启动收口处）。
 * 池按方案划分：方案待办（有 planId）只与同方案活跃任务互斥，不同方案可并行；
 * 普通任务（无 planId）跑项目主工作区，与一切活跃任务（含各方案）互斥。
 */
export function hasFreeSlot(
  tasks: readonly Task[],
  projectId: string,
  configured: number | undefined,
  defaultMaxConcurrent: number,
  planId?: string,
): boolean {
  const max = resolveMaxConcurrent(configured, defaultMaxConcurrent);
  if (planId) {
    // 方案池：同方案活跃任务 + 公共池普通任务（主工作区共享，不得并行）。
    return countOccupiedSlots(tasks, projectId, planId) + countPoolPlain(tasks, projectId) < max;
  }
  // 项目公共池：普通任务与全部活跃任务（含各方案）共享上限。
  return countOccupiedSlots(tasks, projectId) + countPoolPlans(tasks, projectId) < max;
}

/** 项目内活跃的普通任务（无 planId；跑主工作区，须与一切互斥）。 */
function countPoolPlain(tasks: readonly Task[], projectId: string): number {
  let count = 0;
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (!task.planId && isActiveTaskStatus(task.status)) count += 1;
  }
  return count;
}

/** 项目内活跃的方案待办（含各方案），供普通任务的公共池判定用。 */
function countPoolPlans(tasks: readonly Task[], projectId: string): number {
  let count = 0;
  for (const task of tasks) {
    if (task.projectId !== projectId) continue;
    if (task.planId && isActiveTaskStatus(task.status)) count += 1;
  }
  return count;
}

/** 列出占用同一槽位池的活跃任务（供「排队原因」展示：谁在跑）。 */
export function activeTasksInPool(tasks: readonly Task[], projectId: string, planId?: string): Task[] {
  const pool = planId ? `${projectId}::${planId}` : projectId;
  return tasks.filter(
    (task) => task.projectId === projectId && isActiveTaskStatus(task.status) && slotPoolKey(task) === pool,
  );
}

/**
 * `waiting_deps` 任务的等待**原因**——三种情形在 UI 上给的信息完全不同，不能混成
 * 一句「等待」：
 *
 * - `deps`：还有硬前置没完成（含异常/缺失，此时 entries 非空、`needsOverride` 可能为真）；
 * - `slot`：前置已全部满足，但同项目没有空闲并发槽位（在排队，列出占槽任务给用户看谁在跑）；
 * - `loading`：本方案的 deps 尚未解析进缓存（重启首拍 / 刚生成待办）。此时 gate 分支
 *   与「无前置」长得一样（都是空 entries），但**不是**在排队——显示成「排队中」会让用户
 *   对着一个没有任何任务在跑的项目读到「等本项目空出槽位」，自相矛盾。
 *
 * 判定顺序：deps 未加载 → loading；有未满足前置 → deps；否则 slot。
 */
export type PlanWaitReason = "deps" | "slot" | "loading";

export function resolveWaitReason(
  task: Pick<Task, "planId" | "yunxiaoSerialNumber">,
  gate: Pick<PlanTaskGate, "unmet">,
  /** 该任务所属方案的 deps 是否已载入缓存（无 planId 视为已载入）。 */
  depsLoaded: boolean,
): PlanWaitReason {
  // 无 planId 的等待任务（存量的手工等待）没有任何依赖来源，只能是等槽位。
  if (task.planId && !depsLoaded) return "loading";
  return gate.unmet.length > 0 ? "deps" : "slot";
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
  /** planId → 已解析 deps。**条目缺失 = 尚未加载**（重启首拍），该方案本轮不放行。 */
  depsByPlanId: Readonly<Record<string, PlanDeps | undefined>>;
  planById: ReadonlyMap<string, Plan>;
  /** 项目级并发上限（未配置时用 defaultMaxConcurrent）。 */
  maxConcurrentByProjectId: Readonly<Record<string, number | undefined>>;
  defaultMaxConcurrent: number;
}

/**
 * 选出本轮应当自动启动的等待任务 id（按接续顺序）。
 *
 * 只挑选「前置已全部满足（或用户已明确忽略依赖）」的 `waiting_deps` 任务，并按其
 * 槽位池（项目公共池 / 项目+方案池）的空闲槽位截断——同一批被同一前置解锁的任务
 * 因此只会按顺序逐个放行，默认串行；不同方案分属不同池，互不占槽、可并行。
 *
 * 方案在依赖缓存里**没有条目** ≠ 无依赖，而是「deps 尚未加载」：崩溃重启后 tasks
 * 先于 `refreshPlanDeps` 到位，首拍若按无依赖放行，等待任务会绕过门禁直接起跑
 * （前置异常也拦不住）。因此这种方案本轮跳过——deps 到位后会触发下一拍再判。
 * 真正的「无依赖」（存量方案无 deps.json）由 `readPlanDepsFor` 落成空图条目，
 * 走 `evaluateTaskGate` 正常放行。
 */
export function selectAutoStart(input: AutoStartInput): string[] {
  const { tasks, depsByPlanId, planById, maxConcurrentByProjectId, defaultMaxConcurrent } = input;
  const taskBySerial = buildTaskBySerial(tasks);
  // 按槽位池分桶（项目公共池 / 项目+方案池），桶间互不占槽、可并行放行。
  const waitingByPool = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.status !== "waiting_deps") continue;
    const pool = slotPoolKey(task);
    const bucket = waitingByPool.get(pool);
    if (bucket) bucket.push(task);
    else waitingByPool.set(pool, [task]);
  }

  const started: string[] = [];
  for (const waiting of waitingByPool.values()) {
    // 同一池内任务的 projectId / planId 一致，取桶首即可还原池的配置。
    const projectId = waiting[0].projectId;
    const planId = waiting[0].planId;
    const maxConcurrent = resolveMaxConcurrent(
      maxConcurrentByProjectId[projectId],
      defaultMaxConcurrent,
    );
    // 方案池占用 = 同方案活跃任务 + 普通任务（主工作区共享，与方案任务互斥）；
    // 公共池占用 = 普通任务（countOccupiedSlots 无 planId 即公共池口径）。
    const occupied =
      countOccupiedSlots(tasks, projectId, planId) +
      (planId ? countPoolPlain(tasks, projectId) : 0);
    const slots = Math.max(0, maxConcurrent - occupied);
    if (slots === 0) continue;

    const startable = waiting.filter((task) => {
      if (task.planDepsIgnored) return true;
      if (task.planId && !(task.planId in depsByPlanId)) return false;
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
    // deps 未载入（缓存缺该方案条目）≠ 无依赖：报「排队中」会与「没有任何任务在跑」矛盾。
    if (task.planId && !deps) {
      badges.set(task.id, { kind: "loading", count: 0, blocked: false });
      continue;
    }
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

/**
 * 无人值守任务是否该在「一轮结束」时自动收尾。
 *
 * `Stop` 的语义是 agent 自认为本轮做完了（`event_watcher` 映射为 `awaiting_review`，
 * 进程仍存活、不退出）。交互式任务正常情况下要等用户点「标记已完成」；无人值守
 * 任务没有这个人，故此判定为真时前端自动调 `complete_task`（杀进程 → 收拢草稿 →
 * 跑沉淀）并发出 `done`，让下游依赖满足、整链无人接续。
 *
 * 只认 `unattended` 显式开启的任务：普通任务、方案讨论任务一律不自动收尾。
 */
export function shouldAutoCompleteOnStop(
  task: Pick<Task, "unattended">,
  status: TaskStatus,
): boolean {
  return task.unattended === true && status === "awaiting_review";
}

export interface PlanTodoLaunchInput {
  /** 「开始」（一键）路径：不弹确认页，任务直接进等待队列由调度器放行。 */
  autoStart?: boolean;
  /** 无人值守：勾选后整链自动接续（并强制 full_access）。 */
  unattended?: boolean;
  /** 用户选择的权限模式（无人值守时被覆盖）。 */
  permissionMode: PermissionMode;
}

export interface PlanTodoLaunch {
  /** 生成待办时的初始状态。 */
  initialStatus: TaskStatus;
  /** 实际生效的权限模式（无人值守强制 full_access）。 */
  permissionMode: PermissionMode;
}

/**
 * 方案待办生成时的启动参数推导（「开始」与「生成待办」两条入口共用）。
 *
 * - 无人值守 → 一律 `waiting_deps`：整链交给串行调度器按依赖逐个放行，即便是
 *   「生成待办」这种非 autoStart 的入口也不再停在 `todo` 等人点开始。
 * - 无人值守 → 强制 `full_access`：没人点审批、没人答问题，`ask`/`auto_edit`
 *   一遇审批就停在 `input_required` 挂死，无人值守链路直接断掉。
 * - 其余情况维持现状：`autoStart` 进等待队列，否则 `todo`；权限原样保留。
 */
export function resolvePlanTodoLaunch(input: PlanTodoLaunchInput): PlanTodoLaunch {
  if (input.unattended) {
    return { initialStatus: "waiting_deps", permissionMode: "full_access" };
  }
  return {
    initialStatus: input.autoStart ? "waiting_deps" : "todo",
    permissionMode: input.permissionMode,
  };
}
