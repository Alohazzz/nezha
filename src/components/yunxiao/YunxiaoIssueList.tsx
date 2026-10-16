import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  CircleStop,
  Cloud,
  ExternalLink,
  Eye,
  Loader2,
  MessageSquareText,
  Play,
  RefreshCw,
  Terminal,
  Zap,
} from "lucide-react";
import type { YunxiaoWorkitem } from "../../types";
import {
  buildYunxiaoIssueLink,
  getYunxiaoPlanEndDate,
  getYunxiaoPriority,
  getYunxiaoProduct,
  getYunxiaoStatusTone,
  getYunxiaoTypeBadge,
  isYunxiaoIssueOverdue,
  type YunxiaoStatusTone,
} from "../../utils/yunxiao";
import type { YunxiaoIssuePlanInfo, YunxiaoIssuePlanState } from "../../utils/yunxiaoPlanState";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 状态色调 → chip 样式（云效四色系，色值走 themes.css 主题变量）。 */
const STATUS_CHIP_STYLE: Record<YunxiaoStatusTone, React.CSSProperties> = {
  blue: s.yunxiaoStatusChipBlue,
  green: s.yunxiaoStatusChipGreen,
  orange: s.yunxiaoStatusChipOrange,
  grey: s.yunxiaoStatusChipGrey,
};

/** 类型徽标色调 → chip 样式（需求蓝 / 缺陷红）。 */
const TYPE_CHIP_STYLE: Record<"blue" | "red", React.CSSProperties> = {
  blue: s.yunxiaoStatusChipBlue,
  red: s.yunxiaoStatusChipRed,
};

/** 方案状态徽标：语义色向云效四色系靠拢（需要回答最扎眼用 orange）。 */
const PLAN_STATE_BADGE_STYLE: Record<YunxiaoIssuePlanState, React.CSSProperties | null> = {
  none: null,
  discussing: s.yunxiaoStatusChipBlue,
  awaiting_input: s.yunxiaoStatusChipOrange,
  discussion_broken: s.yunxiaoStatusChipOrange,
  finalized: s.yunxiaoStatusChipGreen,
  executing: s.yunxiaoStatusChipGreen,
  completed: s.yunxiaoStatusChipGrey,
  direct_task: s.yunxiaoStatusChipGrey,
};

const PLAN_STATE_LABEL_KEY: Record<YunxiaoIssuePlanState, string | null> = {
  none: null,
  discussing: "yunxiao.planState.discussing",
  awaiting_input: "yunxiao.planState.awaitingInput",
  discussion_broken: "yunxiao.planState.discussionBroken",
  finalized: "yunxiao.planState.finalized",
  executing: "yunxiao.planState.executing",
  completed: "yunxiao.planState.completed",
  direct_task: "yunxiao.planState.directTask",
};

function formatDate(ts: number | undefined): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return "";
  }
}

export function YunxiaoIssueList({
  issues,
  hasMore,
  loading,
  loadingMore,
  importedIds,
  planInfoByIssueId,
  selectedIds,
  selectionMode,
  onToggleSelect,
  onDiscuss,
  onDirectStart,
  onAddToPlan,
  onViewPlan,
  onOpenTask,
  onResumeDiscussion,
  onStartPlan,
  onRediscuss,
  onCancelPlan,
  planNamesByWorkitem,
  onLoadMore,
  yunxiaoProjectId,
  planEndFieldId,
  productFieldId,
}: {
  issues: YunxiaoWorkitem[];
  /** 是否还有未加载页（服务端 total − 已加载）。产品过滤只偷换计数 total，不改变此判断。 */
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  importedIds: ReadonlySet<string>;
  /** 议题 → 方案状态反查结果（App 层批量派生，决定 badge 与行内动作）。 */
  planInfoByIssueId: ReadonlyMap<string, YunxiaoIssuePlanInfo>;
  /** 多选模式下的已选议题 id。 */
  selectedIds: ReadonlySet<string>;
  /** 是否处于多选模式（已选 ≥1 时为 true，隐藏单条发起讨论按钮）。 */
  selectionMode: boolean;
  /** 勾选/取消勾选（imported 议题由父级拦截置灰）。 */
  onToggleSelect: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「发起讨论」快捷入口（与多选发起同一链路；仅无方案议题显示）。 */
  onDiscuss: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「直接开始」快捷入口（仅无方案议题显示；有方案议题走方案链路）。 */
  onDirectStart: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「加到计划」快捷入口（仅无方案议题显示）。 */
  onAddToPlan: (issue: YunxiaoWorkitem) => void;
  /** 查看方案弹窗。 */
  onViewPlan: (issue: YunxiaoWorkitem) => void;
  /** 跳到讨论任务（需要回答 / 讨论中）。 */
  onOpenTask: (issue: YunxiaoWorkitem) => void;
  /** 继续讨论（resume 断掉的讨论任务）。 */
  onResumeDiscussion: (issue: YunxiaoWorkitem) => void;
  /** 执行整个方案（finalized，按 deps 拓扑一键全部启动）。 */
  onStartPlan: (issue: YunxiaoWorkitem) => void;
  /** 删除重议（级联：取消讨论任务 → 删方案 → 自动发起新讨论）。 */
  onRediscuss: (issue: YunxiaoWorkitem) => void;
  /** 取消方案（executing 的逃生通道；确认在弹窗内）。 */
  onCancelPlan: (issue: YunxiaoWorkitem) => void;
  /** workitemId → 所属计划名（单计划归属）；已有计划的议题显示徽标不再提供添加。 */
  planNamesByWorkitem: ReadonlyMap<string, string>;
  onLoadMore: () => void;
  /** 云效云项目 ID（构建源议题链接；空则不显示链接按钮）。 */
  yunxiaoProjectId: string;
  /** 「计划完成时间」自定义字段 ID（提取卡片时间徽标；缺省不展示）。 */
  planEndFieldId?: string | null;
  /** 「所属产品」自定义字段 ID（提取卡片产品徽标；缺省不展示）。 */
  productFieldId?: string | null;
}) {
  const { t } = useI18n();
  const [hoverIssueId, setHoverIssueId] = useState<string | null>(null);

  return (
    <div style={s.yunxiaoList}>
      {loading ? (
        <div style={s.yunxiaoEmpty}>
          <Loader2 size={20} className="spin" />
          <div>{t("yunxiao.loading")}</div>
        </div>
      ) : issues.length === 0 ? (
        <div style={s.yunxiaoEmpty}>
          <Cloud size={28} strokeWidth={1.2} color="var(--text-hint)" />
          <div>{t("yunxiao.noIssues")}</div>
        </div>
      ) : (
        issues.map((issue) => {
          const imported = importedIds.has(issue.id);
          const planInfo = planInfoByIssueId.get(issue.id);
          const hasPlan = !!planInfo && planInfo.state !== "none" && planInfo.state !== "direct_task";
          const badgeKey = planInfo ? PLAN_STATE_LABEL_KEY[planInfo.state] : null;
          const badgeStyle = planInfo ? PLAN_STATE_BADGE_STYLE[planInfo.state] : null;
          const actions = planInfo?.actions;
          const hover = hoverIssueId === issue.id;
          const checked = selectedIds.has(issue.id);
          const priority = getYunxiaoPriority(issue);
          // 状态独立成彩色 chip（云效四色系），不再混入灰色 meta 数组。
          const statusLabel =
            issue.status?.displayName ?? issue.status?.name ?? t("yunxiao.statusUnknown");
          const statusTone = getYunxiaoStatusTone(issue);
          const typeBadge = getYunxiaoTypeBadge(issue.categoryId);
          const planEnd = getYunxiaoPlanEndDate(issue, planEndFieldId ?? undefined);
          const overdue = isYunxiaoIssueOverdue(issue, planEnd);
          const product = getYunxiaoProduct(issue, productFieldId ?? undefined);
          const meta: string[] = [];
          if (product) meta.push(product);
          if (priority) meta.push(priority);
          if (issue.assignedTo) meta.push(issue.assignedTo.name);
          const date = formatDate(issue.gmtCreate);
          if (date) meta.push(date);

          return (
            <div
              key={issue.id}
              className="row-actions-host"
              style={
                checked ? s.yunxiaoIssueCardSelected : hover ? s.yunxiaoIssueCardHover : s.yunxiaoIssueCard
              }
              onMouseEnter={() => setHoverIssueId(issue.id)}
              onMouseLeave={() => setHoverIssueId(null)}
            >
              <label
                style={imported ? s.yunxiaoIssueCheckDisabled : s.yunxiaoIssueCheck}
                title={imported ? t("yunxiao.importDuplicate") : undefined}
              >
                <input
                  type="checkbox"
                  disabled={imported}
                  checked={checked}
                  onChange={() => onToggleSelect(issue)}
                />
              </label>
              <span style={s.yunxiaoIssueSerial}>{issue.serialNumber}</span>
              <div style={s.yunxiaoIssueBody}>
                <div style={s.yunxiaoIssueSubject}>{issue.subject}</div>
                <div style={s.yunxiaoIssueMeta}>
                  {typeBadge && (
                    <span style={TYPE_CHIP_STYLE[typeBadge.tone]}>{t(typeBadge.labelKey)}</span>
                  )}
                  <span style={STATUS_CHIP_STYLE[statusTone]}>{statusLabel}</span>
                  {badgeKey && badgeStyle && (
                    <button
                      type="button"
                      style={{ ...badgeStyle, border: "none", cursor: "pointer" }}
                      title={t("yunxiao.planState.viewHint")}
                      onClick={() => onViewPlan(issue)}
                    >
                      <Eye size={10} strokeWidth={2.4} />
                      {t(badgeKey)}
                    </button>
                  )}
                  {planEnd !== undefined && (
                    <span style={overdue ? s.yunxiaoPlanEndOverdue : s.yunxiaoPlanEndBadge}>
                      {t("yunxiao.planEnd.prefix")}
                      {formatDate(planEnd)}
                      {overdue ? t("yunxiao.planEnd.overdueSuffix") : ""}
                    </span>
                  )}
                  {meta.map((m) => (
                    <span key={m} style={s.yunxiaoMetaBadge}>
                      {m}
                    </span>
                  ))}
                </div>
              </div>
              {yunxiaoProjectId && (
                <button
                  type="button"
                  style={hover ? s.yunxiaoIssueLinkBtnHover : s.yunxiaoIssueLinkBtn}
                  title={t("yunxiao.openInYunxiao")}
                  onClick={() =>
                    openUrl(buildYunxiaoIssueLink(yunxiaoProjectId, issue.id)).catch(() => {})
                  }
                >
                  <ExternalLink size={12} strokeWidth={2} />
                </button>
              )}
              {planNamesByWorkitem.has(issue.id) ? (
                <span style={s.yunxiaoMetaBadge}>
                  在计划 {planNamesByWorkitem.get(issue.id)}
                </span>
              ) : hasPlan && actions ? (
                /* 方案内议题：动作按状态机分支（badge 本身可点查看方案，这里给快捷动作）。 */
                <div className="row-actions" data-testid={`yunxiao-issue-actions-${issue.id}`}>
                  {actions.openTask && (
                    <button
                      type="button"
                      className="row-actions-btn"
                      data-tone={planInfo?.state === "awaiting_input" ? "primary" : "secondary"}
                      onClick={() => onOpenTask(issue)}
                    >
                      <MessageSquareText size={12} strokeWidth={2.2} />
                      {t(
                        planInfo?.state === "awaiting_input"
                          ? "yunxiao.issueActions.answer"
                          : "yunxiao.issueActions.openTask",
                      )}
                    </button>
                  )}
                  {actions.resumeDiscussion && (
                    <button
                      type="button"
                      className="row-actions-btn"
                      data-tone="primary"
                      onClick={() => onResumeDiscussion(issue)}
                    >
                      <RefreshCw size={12} strokeWidth={2.2} />
                      {t("yunxiao.issueActions.resumeDiscussion")}
                    </button>
                  )}
                  {actions.startPlan && (
                    <button
                      type="button"
                      className="row-actions-btn"
                      data-tone="primary"
                      onClick={() => onStartPlan(issue)}
                    >
                      <Play size={12} strokeWidth={2.2} fill="currentColor" />
                      {t("yunxiao.issueActions.startPlan")}
                    </button>
                  )}
                  {actions.continuePlan && (
                    <button
                      type="button"
                      className="row-actions-btn"
                      data-tone="primary"
                      onClick={() => onViewPlan(issue)}
                    >
                      <Play size={12} strokeWidth={2.2} fill="currentColor" />
                      {t("yunxiao.issueActions.continuePlan")}
                    </button>
                  )}
                  {actions.view && (
                    <button
                      type="button"
                      className="row-actions-btn row-actions-secondary"
                      data-tone="secondary"
                      onClick={() => onViewPlan(issue)}
                    >
                      <Eye size={12} strokeWidth={2.2} />
                      {t("yunxiao.issueActions.view")}
                    </button>
                  )}
                  {actions.rediscuss && (
                    <button
                      type="button"
                      className="row-actions-btn row-actions-secondary"
                      data-tone="secondary"
                      onClick={() => onRediscuss(issue)}
                    >
                      {t("yunxiao.issueActions.rediscuss")}
                    </button>
                  )}
                  {actions.cancelPlan && (
                    <button
                      type="button"
                      className="row-actions-btn row-actions-secondary"
                      data-tone="danger"
                      onClick={() => onCancelPlan(issue)}
                    >
                      <CircleStop size={12} strokeWidth={2.2} />
                      {t("yunxiao.issueActions.cancelPlan")}
                    </button>
                  )}
                </div>
              ) : planInfo?.state === "direct_task" ? (
                <button
                  type="button"
                  className="row-actions-btn"
                  data-tone="secondary"
                  style={{ visibility: "visible" }}
                  onClick={() => onOpenTask(issue)}
                >
                  <Terminal size={12} strokeWidth={2.2} />
                  {t("yunxiao.issueActions.locateTask")}
                </button>
              ) : !selectionMode ? (
                /* 顺序：次级动作在左（收起时不占视觉），主操作永远在最右——悬停现身时主操作不位移。 */
                <div className="row-actions" data-testid={`yunxiao-issue-actions-${issue.id}`}>
                  <button
                    type="button"
                    className="row-actions-btn row-actions-secondary"
                    data-tone="secondary"
                    onClick={() => onDiscuss(issue)}
                  >
                    {t("yunxiao.discussion.start")}
                  </button>
                  <button
                    type="button"
                    className="row-actions-btn row-actions-secondary"
                    data-tone="secondary"
                    title="添加到计划"
                    onClick={() => onAddToPlan(issue)}
                  >
                    加到计划
                  </button>
                  <button
                    type="button"
                    className="row-actions-btn"
                    data-tone="primary"
                    title={t("yunxiao.direct.rowHint")}
                    onClick={() => onDirectStart(issue)}
                  >
                    <Zap size={12} strokeWidth={2.2} fill="currentColor" />
                    {t("yunxiao.direct.start")}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {!loading && issues.length > 0 && hasMore && (
        <button
          type="button"
          style={s.yunxiaoLoadMore}
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore && <Loader2 size={12} className="spin" />}
          {t("yunxiao.loadMore")}
        </button>
      )}
    </div>
  );
}
