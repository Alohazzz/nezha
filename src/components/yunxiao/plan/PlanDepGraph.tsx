import { useMemo } from "react";
import { AlertTriangle, Info, Network } from "lucide-react";
import type { TaskStatus } from "../../../types";
import { taskStatusI18nKey } from "../../../types";
import type { PlanTaskRow } from "../../../utils/planBoard";
import type { PlanDeps, PlanDepsWarning } from "../../../utils/planDeps";
import {
  PLAN_GRAPH_LANE,
  layoutPlanDependencyGraph,
  truncateToWidth,
  type PlanGraphEdge,
  type PlanGraphNode,
  type PlanGraphUpstream,
} from "../../../utils/planGraph";
import { useI18n } from "../../../i18n";

/** 边的端点缩进：给箭头留出落点，避免箭头压在节点描边上。 */
const ARROW_INSET = 8;

/** 节点内可用的文本宽度（扣掉左右内边距）。 */
const NODE_TEXT_WIDTH = 132;

/**
 * 边的路径。分两种路由：
 *
 * - **相邻层**：三次贝塞尔，从源节点右缘水平出发、水平进入目标节点左缘。列间空隙里
 *   没有节点，直连是安全的。
 * - **跨层**（跳过至少一列）：必须走节点下方的专用通道，否则会横穿中间列的节点盒子
 *   （实测过：这样画出来的边会被读成「依赖了那个被穿过的节点」）。通道几何由布局层
 *   给出 `laneY`，这里只负责拼圆角折线。
 */
function edgePath(edge: PlanGraphEdge, from: PlanGraphNode, to: PlanGraphNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x - ARROW_INSET;
  const y2 = to.y + to.height / 2;

  if (edge.laneY !== undefined) {
    const run = PLAN_GRAPH_LANE.run;
    const lane = edge.laneY;
    return [
      `M ${x1} ${y1}`,
      // 从源节点右缘平滑下到通道（列间空隙内，不碰节点）
      `C ${x1 + run} ${y1}, ${x1 + run} ${lane}, ${x1 + run * 2} ${lane}`,
      // 沿通道横穿
      `L ${x2 - run * 2} ${lane}`,
      // 平滑升入目标节点左缘
      `C ${x2 - run} ${lane}, ${x2 - run} ${y2}, ${x2} ${y2}`,
    ].join(" ");
  }

  const bend = Math.max(18, (x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** 单条告警 → 文案。 */
function warningText(
  t: (key: string, params?: Record<string, string | number>) => string,
  warning: PlanDepsWarning,
): string {
  switch (warning.kind) {
    case "missing":
      return t("board.graph.warnMissing");
    case "malformed":
      return t("board.graph.warnMalformed");
    case "unknownIssue":
      return t("board.graph.warnUnknownIssue", { serials: warning.serialNumbers.join(", ") });
    case "unknownDependency":
      return t("board.graph.warnUnknownDependency", {
        serials: warning.serialNumbers.join(" → "),
      });
    case "selfDependency":
      return t("board.graph.warnSelf", { serials: warning.serialNumbers.join(", ") });
    case "cycle":
      return t("board.graph.warnCycle", { serials: warning.serialNumbers.join(", ") });
    default:
      return "";
  }
}

/**
 * 方案依赖图：**横向分层**（列 = 依赖深度，左 → 右 = 执行顺序）。节点是紧凑议题卡，
 * 边按前置是否完成着色——满足=绿实线 / 未满足=黄虚线 / 前置异常=红。
 *
 * 交互：悬停节点与任务行共用父级的 `hotSerials` 实现互高亮；单击节点滚动定位到对应
 * 任务行，**不直接打开任务**（看板打开任务会把应用上下文切走，等于离开看板）。
 */
export function PlanDepGraph({
  rows,
  deps,
  upstream,
  hotSerials,
  onHoverSerial,
  onFocusSerial,
  onOpenUpstream,
  loading = false,
}: {
  rows: readonly PlanTaskRow[];
  deps?: PlanDeps;
  /** 跨方案前置议题（追加子方案）：画成第 0 列的外部节点。 */
  upstream?: readonly PlanGraphUpstream[];
  /** 当前高亮的议题编号集合（悬停或选中项的依赖邻域）；为空表示无高亮。 */
  hotSerials: ReadonlySet<string>;
  onHoverSerial: (serial: string | null) => void;
  onFocusSerial: (serial: string) => void;
  /** 点击上游方案节点：列表里没有对应任务行，改为跳到所属方案详情。 */
  onOpenUpstream?: (planId: string) => void;
  /** 依赖文件仍在读取：避免先闪一下「无依赖」再跳成有依赖。 */
  loading?: boolean;
}) {
  const { t } = useI18n();

  const layout = useMemo(() => layoutPlanDependencyGraph(rows, deps, undefined, upstream ?? []), [
    rows,
    deps,
    upstream,
  ]);
  const nodeBySerial = useMemo(() => {
    const map = new Map<string, PlanGraphNode>();
    for (const node of layout.nodes) map.set(node.serialNumber, node);
    return map;
  }, [layout]);

  /**
   * 节点状态：本方案议题取任务行，**上游方案议题取上游数据里带来的 `status`**。
   * 后者不能漏——上游议题在本方案的行里不存在，漏了会被当成「无任务」显示，
   * 而它的边却按真实状态着色，图与文字自相矛盾（正是外部节点要消除的问题）。
   */
  const statusBySerial = useMemo(() => {
    const map = new Map<string, TaskStatus | null>();
    for (const row of rows) map.set(row.serialNumber, row.status);
    for (const entry of upstream ?? []) map.set(entry.serialNumber, entry.status);
    return map;
  }, [rows, upstream]);

  /**
   * 节点序号 = 任务列表里的行号（拓扑序），**不是列内序号**。
   * 两者混用会让同一个任务在图里显示 2、在列表里显示 3，直接读错执行顺序。
   */
  const indexBySerial = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.serialNumber, index + 1));
    return map;
  }, [rows]);

  // missing（无 deps.json）不是错误，是可接受的退化；其余才是需要提醒的问题。
  const problemWarnings = (deps?.warnings ?? []).filter((warning) => warning.kind !== "missing");
  const missingOnly = (deps?.warnings ?? []).some((warning) => warning.kind === "missing");
  const highlightOn = hotSerials.size > 0;
  const hasEdges = layout.edges.length > 0;

  if (rows.length === 0) {
    return (
      <div className="plan-graph-empty">
        <Network size={14} strokeWidth={1.6} />
        {t("board.graph.noIssues")}
      </div>
    );
  }

  return (
    <section className="plan-graph-section" aria-label={t("board.graph.title")}>
      <div className="plan-graph-head">
        <Network size={12} strokeWidth={2} />
        {t("board.graph.title")}
        <span className="plan-crumbs-summary">{t("board.graph.hint")}</span>
      </div>

      {problemWarnings.length > 0 ? (
        <div className="plan-graph-warn" role="status">
          <AlertTriangle size={12} strokeWidth={2} className="plan-graph-warn-icon" />
          <span>{problemWarnings.map((warning) => warningText(t, warning)).join("；")}</span>
        </div>
      ) : missingOnly ? (
        <div className="plan-graph-warn" role="status">
          <Info size={12} strokeWidth={2} className="plan-graph-warn-icon" />
          <span>{t("board.graph.warnMissing")}</span>
        </div>
      ) : null}

      {!hasEdges ? (
        <div className="plan-graph-empty">
          <Network size={14} strokeWidth={1.6} />
          {loading ? t("board.graph.loading") : t("board.graph.noDeps")}
        </div>
      ) : (
        <div className="plan-graph-scroll">
          <svg
            className="plan-graph-svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            aria-label={t("board.graph.title")}
          >
            <defs>
              {(["satisfied", "unmet", "abnormal"] as const).map((state) => (
                <marker
                  key={state}
                  id={`plan-arrow-${state}`}
                  viewBox="0 0 8 8"
                  refX={7}
                  refY={4}
                  markerWidth={5}
                  markerHeight={5}
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 7 4 L 0 7 z" className={`plan-graph-arrow-${state}`} />
                </marker>
              ))}
            </defs>

            <g className="plan-graph-edges">
              {layout.edges.map((edge: PlanGraphEdge) => {
                const source = nodeBySerial.get(edge.from);
                const target = nodeBySerial.get(edge.to);
                if (!source || !target) return null;
                const hot = highlightOn && hotSerials.has(edge.from) && hotSerials.has(edge.to);
                return (
                  <path
                    key={`${edge.from}->${edge.to}`}
                    className="plan-graph-edge"
                    data-state={edge.state}
                    data-hot={highlightOn ? String(hot) : undefined}
                    d={edgePath(edge, source, target)}
                    pathLength={1}
                    markerEnd={`url(#plan-arrow-${edge.state})`}
                  />
                );
              })}
            </g>

            <g className="plan-graph-nodes">
              {layout.nodes.map((node) => {
                const status = statusBySerial.get(node.serialNumber) ?? null;
                const hot = highlightOn && hotSerials.has(node.serialNumber);
                const upstreamPlan = node.upstreamPlanName;
                const stateLabel =
                  status === null ? t("board.noTask") : t(`status.${taskStatusI18nKey(status)}`);
                // 上游方案节点：不在任务列表里有对应行，点击跳所属方案而非滚动定位。
                const activate = () => {
                  if (node.upstreamPlanId && onOpenUpstream) onOpenUpstream(node.upstreamPlanId);
                  else onFocusSerial(node.serialNumber);
                };
                return (
                  <g
                    key={node.serialNumber}
                    className="plan-graph-node"
                    data-status={status ?? "todo"}
                    data-hot={highlightOn ? String(hot) : undefined}
                    data-upstream={upstreamPlan ? "true" : undefined}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      upstreamPlan
                        ? t("board.graph.upstreamNode", {
                            serial: node.serialNumber,
                            plan: upstreamPlan,
                          })
                        : node.serialNumber
                    }
                    onMouseEnter={() => onHoverSerial(node.serialNumber)}
                    onMouseLeave={() => onHoverSerial(null)}
                    onFocus={() => onHoverSerial(node.serialNumber)}
                    onBlur={() => onHoverSerial(null)}
                    onClick={activate}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        activate();
                      }
                    }}
                  >
                    <rect
                      className="plan-graph-node-box"
                      x={node.x}
                      y={node.y}
                      width={node.width}
                      height={node.height}
                      rx={7}
                    />
                    <rect
                      className="plan-graph-node-pulse"
                      x={node.x - 3}
                      y={node.y - 3}
                      width={node.width + 6}
                      height={node.height + 6}
                      rx={9}
                    />
                    <text className="plan-graph-node-index" x={node.x + 8} y={node.y + 17}>
                      {upstreamPlan ? "↗" : (indexBySerial.get(node.serialNumber) ?? node.order + 1)}
                    </text>
                    <text className="plan-graph-node-serial" x={node.x + 22} y={node.y + 17}>
                      {node.serialNumber}
                    </text>
                    <text className="plan-graph-node-subject" x={node.x + 8} y={node.y + 33}>
                      {truncateToWidth(upstreamPlan ? `${upstreamPlan} · ${node.subject}` : node.subject, NODE_TEXT_WIDTH)}
                    </text>
                    <text className="plan-graph-node-state" x={node.x + 8} y={node.y + 46}>
                      {truncateToWidth(stateLabel, NODE_TEXT_WIDTH)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        </div>
      )}
    </section>
  );
}
