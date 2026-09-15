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
import { planAncestorChain } from "./plan";

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

/**
 * 某方案能否接收「追加议题」（阶段三：追加 = 新建子方案）。
 *
 * 条件与「关联方案」下拉的可选范围同源：**已定稿**的方案才有可被依赖的内容（`draft`
 * 的 plan.md 未定稿，决策 R1）；`cancelled` 是留存态且无恢复路径，追加会造出等一个
 * 永不推进的前置、永远标红的子方案；`archived` 表示这条线已收尾移出主列（决策 AR1），
 * 真要追加先反归档即可。三者都排除，剩下的正是 `finalized` / `executing` / `completed`。
 */
export function canReceiveAppend(plan: Pick<Plan, "status" | "archivedAt">): boolean {
  if (isPlanArchived(plan)) return false;
  return plan.status === "finalized" || plan.status === "executing" || plan.status === "completed";
}

/**
 * 「关联方案」下拉的候选清单：**限定同一项目**（方案目录与讨论任务工作目录都落在
 * `<project>/.nezha/plans/` 下，跨项目无意义），且排除不可追加者（见 `canReceiveAppend`）。
 * `excludePlanId` 用于排除正在创建的方案自身。按 createdAt 升序，结果确定。
 */
export function appendableParentPlans(
  plans: readonly Plan[],
  projectId: string,
  excludePlanId?: string,
): Plan[] {
  return plans
    .filter(
      (plan) =>
        plan.projectId === projectId && plan.id !== excludePlanId && canReceiveAppend(plan),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 看板左栏的一行：方案 + 其在「方案树」里的缩进位置。 */
export interface PlanTreeRow {
  plan: Plan;
  /** 缩进层级：0 = 根（或父不在可见范围内）。 */
  depth: number;
  /** 该方案**自身**命中筛选（用于区分「自己命中」与「为带出子方案而显示的祖先」）。 */
  selfMatched: boolean;
  /** 有子方案，可折叠。 */
  hasChildren: boolean;
}

/**
 * 把方案列表组织成左栏的**缩进树**（决策：子方案缩进挂在主方案下，且不能被独立筛选）。
 *
 * 规则：
 * 1. **筛选取子树语义**：任一方案自身命中，就把该方案**及其整条祖先链**纳入可见集。
 *    因此左栏永不出现「父被筛掉、子单独一行」的孤儿态；同时也不出现「主方案已 completed
 *    被筛掉、唯一在执行的子方案反而消失」。仅对根求值做不到这一点。
 * 2. **折叠**：手动折叠隐藏子方案，但**筛选生效时**若折叠会藏掉「因筛选才可见」的命中
 *    后代，则该分支强制展开——否则筛选命中的子方案会被折叠吞掉，筛选等于失效。
 *    筛选未生效时不强制展开：此时所有方案都命中，强制展开等于用户永远收不起子树
 *    （`filtersActive=false` 必须传入，这不是可选的优化）。
 * 3. **顺序**：沿用入参顺序（调用方已按「有任务在动优先 + createdAt」排好），先根后子
 *    深度优先；父不在可见范围内的方案当根处理（不会丢行）。
 */
export function buildPlanTree(
  plans: readonly Plan[],
  /** 筛选谓词：逐方案求值（子树语义由本函数补全）。 */
  matches: (plan: Plan) => boolean,
  /** 用户手动折叠的方案 id。 */
  collapsed: ReadonlySet<string>,
  /** 是否有筛选生效。为 false 时折叠严格生效，不做命中强制展开。 */
  filtersActive: boolean,
): PlanTreeRow[] {
  const byId = new Map<string, Plan>();
  for (const plan of plans) byId.set(plan.id, plan);

  const selfMatched = new Set<string>();
  for (const plan of plans) {
    if (matches(plan)) selfMatched.add(plan.id);
  }

  // 可见集 = 命中集 ∪ 其祖先闭包（祖先必须存在且在同一列表内，断链即当根）。
  const visible = new Set<string>();
  for (const id of selfMatched) {
    visible.add(id);
    for (const ancestor of planAncestorChain(id, plans)) visible.add(ancestor.id);
  }

  // 子方案分组（仅同一列表内的父子关系），保持入参顺序。
  const childrenOf = new Map<string, string[]>();
  for (const plan of plans) {
    const parentId = plan.parentPlanId?.trim();
    if (!parentId || !byId.has(parentId)) continue;
    const list = childrenOf.get(parentId);
    if (list) list.push(plan.id);
    else childrenOf.set(parentId, [plan.id]);
  }

  /** 有任一命中后代时需要强制展开（否则筛选命中被折叠吞掉）。 */
  const hasMatchedDescendant = (id: string): boolean => {
    const stack = [...(childrenOf.get(id) ?? [])];
    const guard = new Set<string>();
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (guard.has(next)) continue;
      guard.add(next);
      if (selfMatched.has(next)) return true;
      stack.push(...(childrenOf.get(next) ?? []));
    }
    return false;
  };

  const rows: PlanTreeRow[] = [];
  const emitted = new Set<string>();
  const emit = (id: string, depth: number): void => {
    if (emitted.has(id)) return;
    const plan = byId.get(id);
    if (!plan) return;
    emitted.add(id);
    const childIds = (childrenOf.get(id) ?? []).filter((child) => visible.has(child));
    rows.push({
      plan,
      depth,
      selfMatched: selfMatched.has(id),
      hasChildren: childIds.length > 0,
    });
    if (collapsed.has(id) && !(filtersActive && hasMatchedDescendant(id))) return;
    for (const child of childIds) emit(child, depth + 1);
  };

  /**
   * 该方案是否「由可见父方案带出」。成环（a↔b）时两者都在等对方先输出，会一个都不出——
   * 因此上溯遇到已访问过的节点即判定为环，让环上节点当根落地（不丢行、不死循环）。
   */
  const broughtOutByParent = (plan: Plan): boolean => {
    const parentId = plan.parentPlanId?.trim();
    if (!parentId || !visible.has(parentId) || !byId.has(parentId)) return false;
    const chain = planAncestorChain(plan.id, plans);
    const last = chain[chain.length - 1];
    const onChain = new Set([plan.id, ...chain.map((item) => item.id)]);
    // 链停在环上（末项仍指向链内节点）→ 环上节点当根；正常链会追到无父的根。
    return !(last?.parentPlanId?.trim() && onChain.has(last.parentPlanId.trim()));
  };

  for (const plan of plans) {
    if (!visible.has(plan.id)) continue;
    if (broughtOutByParent(plan)) continue;
    emit(plan.id, 0);
  }
  return rows;
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
