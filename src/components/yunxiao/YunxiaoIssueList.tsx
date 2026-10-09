import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Cloud, ExternalLink, Loader2, Zap } from "lucide-react";
import type { YunxiaoWorkitem } from "../../types";
import {
  buildYunxiaoIssueLink,
  getYunxiaoPlanEndDate,
  getYunxiaoPriority,
  getYunxiaoProduct,
  getYunxiaoStatusTone,
  isYunxiaoIssueOverdue,
  type YunxiaoStatusTone,
} from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 状态色调 → chip 样式（云效四色系，色值走 themes.css 主题变量）。 */
const STATUS_CHIP_STYLE: Record<YunxiaoStatusTone, React.CSSProperties> = {
  blue: s.yunxiaoStatusChipBlue,
  green: s.yunxiaoStatusChipGreen,
  orange: s.yunxiaoStatusChipOrange,
  grey: s.yunxiaoStatusChipGrey,
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
  total,
  loading,
  loadingMore,
  importedIds,
  selectedIds,
  selectionMode,
  onToggleSelect,
  onDiscuss,
  onDirectStart,
  onAddToPlan,
  planNamesByWorkitem,
  onLoadMore,
  yunxiaoProjectId,
  planEndFieldId,
  productFieldId,
}: {
  issues: YunxiaoWorkitem[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  importedIds: ReadonlySet<string>;
  /** 多选模式下的已选议题 id。 */
  selectedIds: ReadonlySet<string>;
  /** 是否处于多选模式（已选 ≥1 时为 true，隐藏单条发起讨论按钮）。 */
  selectionMode: boolean;
  /** 勾选/取消勾选（imported 议题由父级拦截置灰）。 */
  onToggleSelect: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「发起讨论」快捷入口（与多选发起同一链路）。 */
  onDiscuss: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「直接开始」快捷入口（跳过讨论，直接创建执行任务）。 */
  onDirectStart: (issue: YunxiaoWorkitem) => void;
  /** 行内单条「加到计划」快捷入口。 */
  onAddToPlan: (issue: YunxiaoWorkitem) => void;
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
          const hover = hoverIssueId === issue.id;
          const checked = selectedIds.has(issue.id);
          const priority = getYunxiaoPriority(issue);
          // 状态独立成彩色 chip（云效四色系），不再混入灰色 meta 数组。
          const statusLabel =
            issue.status?.displayName ?? issue.status?.name ?? t("yunxiao.statusUnknown");
          const statusTone = getYunxiaoStatusTone(issue);
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
                  <span style={STATUS_CHIP_STYLE[statusTone]}>{statusLabel}</span>
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
              ) : imported ? (
                <span style={s.yunxiaoImportedBadge}>
                  <Check size={12} strokeWidth={2.5} />
                  {t("yunxiao.imported")}
                </span>
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
      {!loading && issues.length > 0 && issues.length < total && (
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
