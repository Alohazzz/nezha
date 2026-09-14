/**
 * 方案依赖（deps.json）的解析、校验与拓扑排序纯函数。
 *
 * 契约由 SkillHub `yunxiao-plan-discussion` 技能维护，文件与 plan.md 同目录
 * （`.nezha/plans/<planId>/deps.json`）：
 *
 *   {
 *     "version": 1,
 *     "issues": [{ "serialNumber": "QHDK-29749", "dependsOn": [] }],
 *     "executionOrder": ["QHDK-29749", "QHDK-29750"]
 *   }
 *
 * 本模块只做纯计算：不做 IO、不感知 Task 状态机。「前置是否已完成」由调用方以
 * 判定函数注入（见 `unmetDependencies`）。方案外的编号、自依赖、成环一律就地剔除
 * 并记入 `warnings` —— 门禁宁可少拦，也不能因为一份坏文件把任务永久卡住。
 */

/** 硬依赖图：议题编号 → 直接前置的议题编号（方案内每个议题都有键，无依赖为空数组）。 */
export type PlanDepGraph = Record<string, string[]>;

export type PlanDepsWarningKind =
  /** 文件缺失 / 内容为空：视为无依赖 */
  | "missing"
  /** JSON 损坏或结构不符合契约：能读多少读多少 */
  | "malformed"
  /** 出现了方案议题清单之外的编号 */
  | "unknownIssue"
  /** dependsOn 指向方案外的编号：该边丢弃 */
  | "unknownDependency"
  /** 议题依赖自身：该边丢弃 */
  | "selfDependency"
  /** 硬依赖成环：环上边全部丢弃（避免门禁死锁） */
  | "cycle";

export interface PlanDepsWarning {
  kind: PlanDepsWarningKind;
  /** 相关议题编号；缺失 / 损坏类警告为空数组，unknownDependency 的首项为承载该边的议题 */
  serialNumbers: string[];
  /** 人类可读细节，仅供日志与调试；UI 文案由调用方按 kind 生成 */
  detail?: string;
}

export interface PlanDeps {
  /** 过滤并破环后的硬依赖图；方案内每个议题都有键 */
  graph: PlanDepGraph;
  /** 建议执行顺序（已过滤到方案内编号并去重，缺失者按 planSerials 顺序补尾） */
  executionOrder: string[];
  /** 解析过程中发现的问题；空数组表示完全干净 */
  warnings: PlanDepsWarning[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 议题编号去重（去首尾空白、丢弃空串），保持首次出现顺序。 */
function uniqueSerials(serials: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of serials) {
    const serial = raw.trim();
    if (!serial || seen.has(serial)) continue;
    seen.add(serial);
    result.push(serial);
  }
  return result;
}

/**
 * 破环：把每个强连通分量（size > 1）内部的边整体丢弃。只删环内边即可让剩余图为
 * DAG，且不误伤跨环的正常依赖；语义上等同「卷进环里的依赖都不可信」。
 * 用迭代式 Tarjan（而非递归），避免议题数异常时爆栈。
 */
function breakCycles(
  graph: PlanDepGraph,
  serials: readonly string[],
  warnings: PlanDepsWarning[],
): void {
  const count = serials.length;
  const idOf = new Map<string, number>();
  serials.forEach((serial, id) => idOf.set(serial, id));

  // 转成整数邻接表：既避开非空断言，也让下面的下标访问保持类型安全。
  const out: number[][] = serials.map((serial) =>
    (graph[serial] ?? []).flatMap((dep) => {
      const id = idOf.get(dep);
      return id === undefined ? [] : [id];
    }),
  );

  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const components: number[][] = [];
  let counter = 0;

  for (let root = 0; root < count; root += 1) {
    if (index[root] !== -1) continue;
    const work: Array<{ node: number; next: number }> = [{ node: root, next: 0 }];
    index[root] = counter;
    low[root] = counter;
    counter += 1;
    stack.push(root);
    onStack[root] = 1;

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const children = out[frame.node];
      if (frame.next < children.length) {
        const child = children[frame.next];
        frame.next += 1;
        if (index[child] === -1) {
          index[child] = counter;
          low[child] = counter;
          counter += 1;
          stack.push(child);
          onStack[child] = 1;
          work.push({ node: child, next: 0 });
        } else if (onStack[child] === 1) {
          low[frame.node] = Math.min(low[frame.node], index[child]);
        }
        continue;
      }

      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low[parent] = Math.min(low[parent], low[frame.node]);
      }
      if (low[frame.node] === index[frame.node]) {
        const component: number[] = [];
        for (;;) {
          const node = stack.pop();
          if (node === undefined) break;
          onStack[node] = 0;
          component.push(node);
          if (node === frame.node) break;
        }
        components.push(component);
      }
    }
  }

  for (const component of components) {
    if (component.length < 2) continue;
    const inComponent = new Set(component);
    for (const id of component) {
      const serial = serials[id];
      graph[serial] = (graph[serial] ?? []).filter((dep) => {
        const depId = idOf.get(dep);
        return depId === undefined || !inComponent.has(depId);
      });
    }
    warnings.push({
      kind: "cycle",
      serialNumbers: component.map((id) => serials[id]).sort(),
      detail: "环上硬依赖已全部降级为无依赖，避免门禁死锁",
    });
  }
}

/** 归一化建议执行顺序：过滤方案外编号与重复项，方案内漏掉的议题按 planSerials 顺序补尾。 */
function normalizeExecutionOrder(
  raw: unknown,
  serials: readonly string[],
  warnings: PlanDepsWarning[],
): string[] {
  if (raw !== undefined && !Array.isArray(raw)) {
    warnings.push({ kind: "malformed", serialNumbers: [], detail: "executionOrder 不是数组" });
  }
  const member = new Set(serials);
  const seen = new Set<string>();
  const order: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const serial = item.trim();
      if (!member.has(serial) || seen.has(serial)) continue;
      seen.add(serial);
      order.push(serial);
    }
  }
  for (const serial of serials) {
    if (seen.has(serial)) continue;
    seen.add(serial);
    order.push(serial);
  }
  return order;
}

/**
 * 解析 deps.json 文本。`raw` 为 null / undefined / 空白时按「无依赖」处理（存量方案与
 * agent 未按契约产出的情况），任务照常启动、不做门禁。
 *
 * `planSerials` 是本方案的议题编号清单，作为唯一的合法编号来源（与 plan.md 的
 * `## <编号> ` 节、`Task.yunxiaoSerialNumber` 同一字符串）。
 */
export function parsePlanDeps(
  raw: string | null | undefined,
  planSerials: readonly string[],
): PlanDeps {
  const serials = uniqueSerials(planSerials);
  const member = new Set(serials);
  const warnings: PlanDepsWarning[] = [];
  const graph: PlanDepGraph = {};
  for (const serial of serials) graph[serial] = [];

  const text = raw?.trim();
  if (!text) {
    warnings.push({ kind: "missing", serialNumbers: [], detail: "未找到 deps.json，按无依赖处理" });
    return { graph, executionOrder: [...serials], warnings };
  }

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (error) {
    warnings.push({ kind: "malformed", serialNumbers: [], detail: `JSON 解析失败：${String(error)}` });
    return { graph, executionOrder: [...serials], warnings };
  }

  if (!isPlainObject(root)) {
    warnings.push({ kind: "malformed", serialNumbers: [], detail: "顶层不是 JSON 对象" });
    return { graph, executionOrder: [...serials], warnings };
  }

  // 版本只做存在性提示：未来升版时允许旧代码读到告警而不是静默按 v1 误读。
  if (typeof root.version === "number" && root.version !== 1) {
    warnings.push({ kind: "malformed", serialNumbers: [], detail: `未知的 deps.json 版本：${root.version}` });
  }

  if (root.issues !== undefined && !Array.isArray(root.issues)) {
    warnings.push({ kind: "malformed", serialNumbers: [], detail: "issues 不是数组" });
  }
  const entries = Array.isArray(root.issues) ? root.issues : [];

  entries.forEach((entry, position) => {
    if (!isPlainObject(entry) || typeof entry.serialNumber !== "string") {
      warnings.push({ kind: "malformed", serialNumbers: [], detail: `issues[${position}] 缺少 serialNumber` });
      return;
    }
    const serial = entry.serialNumber.trim();
    if (!member.has(serial)) {
      warnings.push({ kind: "unknownIssue", serialNumbers: [serial] });
      return;
    }
    if (entry.dependsOn !== undefined && !Array.isArray(entry.dependsOn)) {
      warnings.push({ kind: "malformed", serialNumbers: [serial], detail: "dependsOn 不是数组" });
    }
    const rawDeps = Array.isArray(entry.dependsOn) ? entry.dependsOn : [];
    const deps = graph[serial];
    for (const rawDep of rawDeps) {
      if (typeof rawDep !== "string") {
        warnings.push({ kind: "malformed", serialNumbers: [serial], detail: "dependsOn 含非字符串项" });
        continue;
      }
      const dep = rawDep.trim();
      if (dep === serial) {
        warnings.push({ kind: "selfDependency", serialNumbers: [serial] });
        continue;
      }
      if (!member.has(dep)) {
        warnings.push({ kind: "unknownDependency", serialNumbers: [serial, dep] });
        continue;
      }
      if (!deps.includes(dep)) deps.push(dep);
    }
  });

  breakCycles(graph, serials, warnings);

  return {
    graph,
    executionOrder: normalizeExecutionOrder(root.executionOrder, serials, warnings),
    warnings,
  };
}

/**
 * 按硬依赖做拓扑排序，保证前置排在后续之前。同层（当前无未满足前置）的议题按
 * `executionOrder` 的位置优先，其次按 `planSerials` 的给定顺序 —— 结果完全确定。
 *
 * 入参预期来自 `parsePlanDeps`（已无环）；万一仍有环，剩余议题按同一排序规则补尾，
 * 绝不丢议题、也绝不空转。
 */
export function topoSortPlanIssues(
  planSerials: readonly string[],
  graph: PlanDepGraph,
  executionOrder?: readonly string[],
): string[] {
  const serials = uniqueSerials(planSerials);
  const member = new Set(serials);
  const rankOf = new Map<string, number>();
  for (const raw of [...(executionOrder ?? []), ...serials]) {
    const serial = raw.trim();
    if (!member.has(serial) || rankOf.has(serial)) continue;
    rankOf.set(serial, rankOf.size);
  }
  const rank = (serial: string): number => rankOf.get(serial) ?? serials.length;

  const indegree = new Map<string, number>();
  for (const serial of serials) {
    let count = 0;
    for (const dep of graph[serial] ?? []) {
      if (member.has(dep)) count += 1;
    }
    indegree.set(serial, count);
  }

  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < serials.length) {
    let next: string | null = null;
    for (const serial of serials) {
      if (placed.has(serial) || (indegree.get(serial) ?? 0) !== 0) continue;
      if (next === null || rank(serial) < rank(next)) next = serial;
    }
    if (next === null) break;
    order.push(next);
    placed.add(next);
    for (const serial of serials) {
      if (placed.has(serial)) continue;
      if (!(graph[serial] ?? []).includes(next)) continue;
      indegree.set(serial, (indegree.get(serial) ?? 0) - 1);
    }
  }

  const leftovers = serials.filter((serial) => !placed.has(serial)).sort((a, b) => rank(a) - rank(b));
  return [...order, ...leftovers];
}

/**
 * 返回 `serial` 尚未满足的直接硬依赖（保持图内的顺序）。
 * 判定「满足」的口径由调用方注入：方案待办场景下即「前置任务 status === done」。
 */
export function unmetDependencies(
  graph: PlanDepGraph,
  serial: string,
  isSatisfied: (serialNumber: string) => boolean,
): string[] {
  return (graph[serial] ?? []).filter((dep) => !isSatisfied(dep));
}

/**
 * 若把「`serial` 依赖 `dep`」这条边加进图，是否形成环。
 * 判定方式：`dep` 沿现有硬依赖能否到达 `serial`（含 `dep === serial` 的自依赖）。
 * 确认页编辑依赖时用它做实时环检测——成环的编辑直接拒绝，而不是落盘后再破环。
 */
export function createsDependencyCycle(
  graph: PlanDepGraph,
  serial: string,
  dep: string,
): boolean {
  const from = serial.trim();
  const to = dep.trim();
  if (!from || !to || from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    if (node === from) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph[node] ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return false;
}

/** 把编辑后的依赖图序列化回 deps.json 文本（单事实源，与技能契约同 schema）。 */
export function serializePlanDeps(graph: PlanDepGraph, executionOrder: readonly string[]): string {
  const order = uniqueSerials(executionOrder);
  const seen = new Set(order);
  const issues = order.map((serial) => ({
    serialNumber: serial,
    dependsOn: [...(graph[serial] ?? [])],
  }));
  // 图里有但 executionOrder 漏掉的编号也补上，避免丢边。
  for (const serial of Object.keys(graph)) {
    if (seen.has(serial)) continue;
    seen.add(serial);
    order.push(serial);
    issues.push({ serialNumber: serial, dependsOn: [...(graph[serial] ?? [])] });
  }
  return `${JSON.stringify({ version: 1, issues, executionOrder: order }, null, 2)}\n`;
}

