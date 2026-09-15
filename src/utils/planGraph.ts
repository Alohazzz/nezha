/**
 * 方案依赖图的**横向分层布局**（左 → 右 = 执行顺序）。
 *
 * 纯计算：只把「任务行 + 依赖图」派生为节点坐标与边，不含任何渲染。列 = 依赖深度
 * （`layer`，无前置为第 0 层），行内顺序沿用任务行给定的顺序（`derivePlanTaskRows`
 * 已按拓扑序排列，因此读下来就是接续顺序）。
 *
 * 强连通环由 `parsePlanDeps` 提前破掉；本模块仍对环做兜底——残留环上节点按已算出的
 * 层落位，绝不丢节点、也绝不无限递归。
 */
import type { Plan, Task, TaskStatus } from "../types";
import type { PlanTaskRow } from "./planBoard";
import type { PlanDeps } from "./planDeps";
import { planAncestorChain, planTitle } from "./plan";
import { buildTaskBySerial } from "./planQueue";

/** 单条依赖边的状态：满足（实线）/ 未满足（虚线）/ 前置异常（红）。 */
export type PlanDepEdgeState = "satisfied" | "unmet" | "abnormal";

/**
 * 前置任务状态 → 边状态。口径与运行时门禁一致（`depNeedsOverride`）：
 * 前置缺失或 `failed`/`cancelled`/`interrupted` 都算异常，需要人工决定是否越过。
 */
export function dependencyEdgeState(status: TaskStatus | null | undefined): PlanDepEdgeState {
  if (status === "done") return "satisfied";
  if (status === undefined || status === null) return "abnormal";
  if (status === "failed" || status === "cancelled" || status === "interrupted") return "abnormal";
  return "unmet";
}

export interface PlanGraphNode {
  serialNumber: string;
  subject: string;
  /** 依赖深度：0 = 无前置。也是列下标。 */
  layer: number;
  /** 列内序号（从 0 起）。 */
  order: number;
  /** 节点左上角坐标（相对图内容原点；渲染时再平移）。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * 上游方案议题（追加子方案的跨方案前置）。这类节点**不是本方案的议题**：
   * 不在任务列表里有对应的行，点击不能滚动定位，只能跳转到所属方案。
   */
  upstreamPlanName?: string;
  /** 上游节点所属方案 id（跳转用；仅上游节点有值）。 */
  upstreamPlanId?: string;
}

export interface PlanGraphEdge {
  /** 前置议题编号。 */
  from: string;
  /** 依赖方议题编号。 */
  to: string;
  state: PlanDepEdgeState;
  fromLayer: number;
  toLayer: number;
  /**
   * 跨层边的**专用通道 y**（仅当 `toLayer - fromLayer > 1` 时给值）。
   *
   * 相邻层之间的边从列间空隙穿过，不会碰到节点；但**跨层**边会横穿中间列，直线
   * 路由会从无关节点的方框里穿过去（已实测：29753→29754 穿过 29751 与 29752 的盒子），
   * 语义上等于把「依赖谁」画错。跨层边因此统一降到所有节点下方的独立通道，逐个错开，
   * 保证不穿过任何节点盒。
   */
  laneY?: number;
}

export interface PlanGraphLayout {
  nodes: PlanGraphNode[];
  edges: PlanGraphEdge[];
  /** 内容尺寸（含内边距）；小于容器时由调用方决定居中或拉伸。 */
  width: number;
  height: number;
  layerCount: number;
}

export interface PlanGraphMetrics {
  nodeWidth: number;
  nodeHeight: number;
  /** 列间距（净间隙，不含节点宽度）。 */
  gapX: number;
  /** 行间距（净间隙，不含节点高度）。 */
  gapY: number;
  /** 四周留白：给边的弧线与箭头留出空间。 */
  padding: number;
}

const PLAN_GRAPH_METRICS: PlanGraphMetrics = {
  nodeWidth: 148,
  nodeHeight: 52,
  gapX: 72,
  gapY: 14,
  padding: 14,
};

/** 跨层边通道：与内容底部的净间距、通道之间的间距、拐角水平过渡长度。
 *  `2 * LANE_RUN` 必须小于 `gapX`，否则拐角会伸进相邻列的节点范围内。 */
const LANE_INSET = 16;
const LANE_GAP = 18;
const LANE_RUN = 16;
/** 跨层边通道的几何参数（渲染层拼路径时要用，故导出）。 */
export const PLAN_GRAPH_LANE = { inset: LANE_INSET, gap: LANE_GAP, run: LANE_RUN } as const;

/**
 * 最长路径分层（迭代式 Kahn，避免深链递归爆栈）。
 *
 * `layer(n) = 0`（无前置）；否则 `1 + max(layer(前置))`。返回的 Map 对 `rows` 里每个
 * 编号都有值。残留环（理论上已被 `parsePlanDeps` 破掉）上无法出队的节点保留其已算出的
 * 层，保证不丢节点。
 */
function computeLayers(
  serials: readonly string[],
  graph: Record<string, readonly string[]>,
): Map<string, number> {
  const member = new Set(serials);
  const layer = new Map<string, number>();
  const pending = new Map<string, number>();

  for (const serial of serials) {
    layer.set(serial, 0);
    let count = 0;
    for (const dep of graph[serial] ?? []) {
      if (member.has(dep) && dep !== serial) count += 1;
    }
    pending.set(serial, count);
  }

  const queue: string[] = [];
  for (const serial of serials) {
    if ((pending.get(serial) ?? 0) === 0) queue.push(serial);
  }

  while (queue.length > 0) {
    const serial = queue.shift() as string;
    const nextLayer = (layer.get(serial) ?? 0) + 1;
    for (const candidate of serials) {
      if (!(graph[candidate] ?? []).includes(serial)) continue;
      if ((pending.get(candidate) ?? 0) === 0) continue;
      if (nextLayer > (layer.get(candidate) ?? 0)) layer.set(candidate, nextLayer);
      const remaining = (pending.get(candidate) ?? 0) - 1;
      pending.set(candidate, remaining);
      if (remaining === 0) queue.push(candidate);
    }
  }

  return layer;
}

/**
 * 上游方案议题（追加子方案的跨方案前置）：供图里画成**外部节点**。
 *
 * 只包含「本方案议题**直接**依赖」的那些上游议题——不递归展开上游自己的前置，
 * 否则一份多级追加会把图撑成跨方案全景。`planName` 用于在节点上标注所属方案。
 */
export interface PlanGraphUpstream {
  serialNumber: string;
  subject: string;
  /** 所属（祖先）方案 id —— 点击跳转用。 */
  planId: string;
  planName: string;
  /** 该上游议题任务的状态；无任务为 null（按 abnormal 呈现，与门禁 missing 同口径）。 */
  status: TaskStatus | null;
}

/**
 * 从「本方案的依赖图 + 祖先链」派生图里要画的上游方案议题。
 *
 * 只挑**直接被引用**的祖先议题（`deps.graph` 里本方案议题指向的编号），并限定在祖先链内——
 * 链外编号在解析阶段已被丢弃，这里再取一次交集是为了防御「解析时带白名单、渲染时方案已变」
 * 这类不一致。标题与状态都取**祖先方案那份快照**与**全局任务**。
 */
export function deriveUpstreamGraphNodes(
  plan: Pick<Plan, "id" | "issues">,
  plans: readonly Plan[],
  tasks: readonly Task[],
  deps: PlanDeps | undefined,
): PlanGraphUpstream[] {
  const graph = deps?.graph;
  if (!graph) return [];

  const own = new Set(plan.issues.map((issue) => issue.serialNumber));
  const referenced = new Set<string>();
  for (const [serial, depsOfSerial] of Object.entries(graph)) {
    if (!own.has(serial)) continue;
    for (const dep of depsOfSerial) {
      if (!own.has(dep)) referenced.add(dep);
    }
  }
  if (referenced.size === 0) return [];

  const taskBySerial = buildTaskBySerial(tasks);

  const nodes: PlanGraphUpstream[] = [];
  for (const ancestor of planAncestorChain(plan.id, plans)) {
    const planName = planTitle(ancestor);
    for (const issue of ancestor.issues) {
      if (!referenced.has(issue.serialNumber)) continue;
      nodes.push({
        serialNumber: issue.serialNumber,
        subject: issue.subject,
        planId: ancestor.id,
        planName,
        status: taskBySerial.get(issue.serialNumber)?.status ?? null,
      });
    }
  }
  return nodes;
}

/**
 * 把任务行 + 依赖图摆成从左到右的分层图。`deps` 缺省 = 无依赖（全部落在第 0 层）。
 *
 * 列内纵向**居中对齐**：列高不同时上下留白均分，视觉上整列围绕中线展开而不是顶对齐。
 *
 * `upstream` 给的是追加子方案的跨方案前置：这些议题会被画成第 0 列的**外部节点**
 * （虚线描边 + 标注所属方案），从而让「本方案议题依赖上游议题」这条边有端点。
 * 没有它的话，子议题会落在第 0 层、装作无前置，与任务行里「等 QHDK-XXX」的说法矛盾。
 */
export function layoutPlanDependencyGraph(
  rows: readonly PlanTaskRow[],
  deps: PlanDeps | undefined,
  metrics: PlanGraphMetrics = PLAN_GRAPH_METRICS,
  upstream: readonly PlanGraphUpstream[] = [],
): PlanGraphLayout {
  const { nodeWidth, nodeHeight, gapX, gapY, padding } = metrics;
  const graph = deps?.graph ?? {};
  const ownSerials = rows.map((row) => row.serialNumber);
  const ownMember = new Set(ownSerials);

  const upstreamBySerial = new Map<string, PlanGraphUpstream>();
  for (const entry of upstream) upstreamBySerial.set(entry.serialNumber, entry);

  // 只画被本方案议题直接引用的上游节点；编号排序保证布局可复现。
  const referenced = new Set<string>();
  for (const row of rows) {
    for (const dep of graph[row.serialNumber] ?? []) {
      if (ownMember.has(dep) || dep === row.serialNumber) continue;
      if (upstreamBySerial.has(dep)) referenced.add(dep);
    }
  }
  const upstreamSerials = [...referenced].sort();

  // 上游节点作为「无前置的额外节点」一起参与分层——这样依赖它们的本方案议题
  // 才会落到第 ≥1 层，而不是谎称无前置。
  const allSerials = [...upstreamSerials, ...ownSerials];
  const member = new Set(allSerials);
  const layerOf = computeLayers(allSerials, graph);

  // 列内顺序 = 上游节点在前，随后是本方案任务行（已按拓扑序；同层即建议执行顺序）。
  const columns = new Map<number, Array<{ serialNumber: string; subject: string; upstream?: PlanGraphUpstream }>>();
  let layerCount = 0;
  const items = [
    ...upstreamSerials.map((serial) => ({
      serialNumber: serial,
      subject: upstreamBySerial.get(serial)?.subject ?? serial,
      upstream: upstreamBySerial.get(serial),
    })),
    ...rows.map((row) => ({ serialNumber: row.serialNumber, subject: row.subject })),
  ];
  for (const item of items) {
    const layer = layerOf.get(item.serialNumber) ?? 0;
    layerCount = Math.max(layerCount, layer + 1);
    const column = columns.get(layer);
    if (column) column.push(item);
    else columns.set(layer, [item]);
  }

  const columnHeights = new Map<number, number>();
  for (const [layer, column] of columns) {
    columnHeights.set(layer, column.length * nodeHeight + (column.length - 1) * gapY);
  }
  const tallest = Math.max(0, ...columnHeights.values());

  const nodes: PlanGraphNode[] = [];
  const nodeBySerial = new Map<string, PlanGraphNode>();
  for (const [layer, column] of columns) {
    const top = padding + (tallest - (columnHeights.get(layer) ?? 0)) / 2;
    column.forEach((item, order) => {
      const node: PlanGraphNode = {
        serialNumber: item.serialNumber,
        subject: item.subject,
        layer,
        order,
        x: padding + layer * (nodeWidth + gapX),
        y: top + order * (nodeHeight + gapY),
        width: nodeWidth,
        height: nodeHeight,
        upstreamPlanName: item.upstream?.planName,
        upstreamPlanId: item.upstream?.planId,
      };
      nodes.push(node);
      nodeBySerial.set(item.serialNumber, node);
    });
  }

  const statusBySerial = new Map<string, TaskStatus | null>();
  for (const row of rows) statusBySerial.set(row.serialNumber, row.status);
  for (const serial of upstreamSerials) {
    statusBySerial.set(serial, upstreamBySerial.get(serial)?.status ?? null);
  }

  const edges: PlanGraphEdge[] = [];
  for (const serial of allSerials) {
    const target = nodeBySerial.get(serial);
    if (!target) continue;
    for (const dep of graph[serial] ?? []) {
      if (!member.has(dep) || dep === serial) continue;
      const source = nodeBySerial.get(dep);
      if (!source) continue;
      edges.push({
        from: dep,
        to: serial,
        state: dependencyEdgeState(statusBySerial.get(dep) ?? null),
        fromLayer: source.layer,
        toLayer: target.layer,
      });
    }
  }

  /**
   * 跨层边（跳过至少一列）会横穿中间列，直线路由会从无关节点的盒子里穿过去。
   * 给它们逐个分配节点下方的独立通道；排序固定（层号 → 编号），通道分配可复现。
   */
  const skipping = edges
    .filter((edge) => edge.toLayer - edge.fromLayer > 1)
    .sort(
      (a, b) =>
        a.fromLayer - b.fromLayer ||
        a.toLayer - b.toLayer ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to),
    );
  const laneTop = padding + tallest + LANE_INSET;
  skipping.forEach((edge, index) => {
    edge.laneY = laneTop + index * LANE_GAP;
  });

  // 高度要算上通道区（无跨层边时与原来一致）。
  const laneSpace =
    skipping.length > 0 ? LANE_INSET + (skipping.length - 1) * LANE_GAP + padding : 0;

  return {
    nodes,
    edges,
    width: padding * 2 + layerCount * nodeWidth + Math.max(0, layerCount - 1) * gapX,
    height: padding * 2 + tallest + laneSpace,
    layerCount,
  };
}

/**
 * 某议题的「依赖邻域」= 自身 + 全部上游前置 + 全部下游依赖方（传递闭包）。
 * 图与列表联动时用它决定高亮范围：选中一个任务，只看它那条因果链。
 *
 * 迭代式双向遍历；成环时靠 `seen` 收敛，不会死循环。
 */
export function planGraphNeighborhood(
  serial: string,
  graph: Record<string, readonly string[]>,
  /** 反向邻接表：编号 → 依赖它的编号。缺省时按 `graph` 现算。 */
  dependents?: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>([serial]);
  if (!serial) return seen;

  const reverse = dependents ?? buildDependents(graph);

  // 上游：沿 dependsOn 递归。
  const up = [serial];
  while (up.length > 0) {
    const current = up.pop() as string;
    for (const dep of graph[current] ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      up.push(dep);
    }
  }

  // 下游：沿反向邻接表递归。
  const down = [serial];
  while (down.length > 0) {
    const current = down.pop() as string;
    for (const next of reverse.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      down.push(next);
    }
  }

  return seen;
}

/** 反向邻接表：编号 → 直接依赖它的编号。 */
export function buildDependents(graph: Record<string, readonly string[]>): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [serial, deps] of Object.entries(graph)) {
    if (!reverse.has(serial)) reverse.set(serial, []);
    for (const dep of deps) {
      const list = reverse.get(dep);
      if (list) list.push(serial);
      else reverse.set(dep, [serial]);
    }
  }
  return reverse;
}

/** 全角字符近似宽度（CJK / 全角标点占一个字宽，其余按英文估）。 */
function charWidth(char: string): number {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(
    char,
  )
    ? 10
    : 5.4;
}

/** 按像素宽度截断文本（SVG `<text>` 没有 text-overflow，只能自己量）。 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (!text) return "";
  let width = 0;
  let result = "";
  for (const char of text) {
    const next = width + charWidth(char);
    if (next > maxWidth) return result.length > 0 ? `${result}…` : `${char}…`;
    width = next;
    result += char;
  }
  return result;
}
