import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { YunxiaoWorkitem } from "../../../types";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

/** 单议题拉取状态：pending → loading → done | failed；removed = 用户剔除。 */
export type PlanLaunchItemStatus = "pending" | "loading" | "done" | "failed" | "removed";

export interface PlanLaunchItem {
  issue: YunxiaoWorkitem;
  status: PlanLaunchItemStatus;
  detail?: YunxiaoWorkitem;
  imagePaths: string[];
  imageWarning?: string;
  error?: string;
}

/**
 * 发起讨论对话框的议题拉取列表：每行显示拉取状态 / 图片结果，失败行给「重试 / 剔除」。
 * 已剔除（removed）的行不渲染。
 *
 * 抽成独立组件是为了让 `PlanLaunchDialog` 不越过 AGENTS.md 的 400 行上限。
 */
export function PlanLaunchItemList({
  items,
  onRetry,
  onRemove,
}: {
  items: readonly PlanLaunchItem[];
  onRetry: (issueId: string) => void;
  onRemove: (issueId: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div style={s.planLaunchList}>
      {items
        .filter((item) => item.status !== "removed")
        .map((item) => (
          <div key={item.issue.id} style={s.planLaunchItem}>
            <span style={s.planLaunchStatus}>
              {item.status === "loading" || item.status === "pending" ? (
                <Loader2 size={13} className="spin" />
              ) : item.status === "done" ? (
                <CheckCircle2 size={13} color="var(--success, #34c759)" />
              ) : (
                <AlertTriangle size={13} color="var(--danger)" />
              )}
            </span>
            <div style={s.planLaunchItemBody}>
              <div style={s.planLaunchItemTitle}>
                <span style={s.yunxiaoIssueSerial}>{item.issue.serialNumber}</span>
                {item.issue.subject}
              </div>
              {(item.status === "done" && (item.imagePaths.length > 0 || item.imageWarning)) ||
              item.status === "failed" ? (
                <div style={s.planLaunchItemNote}>
                  {item.status === "done" ? (
                    <>
                      {item.imagePaths.length > 0 &&
                        t("plan.launch.itemImages", { count: item.imagePaths.length })}
                      {item.imageWarning ? ` · ${item.imageWarning}` : ""}
                    </>
                  ) : (
                    item.error
                  )}
                </div>
              ) : null}
            </div>
            {item.status === "failed" && (
              <div style={s.planLaunchItemActions}>
                <button
                  type="button"
                  style={s.knowledgeSecondaryBtn}
                  onClick={() => onRetry(item.issue.id)}
                >
                  {t("yunxiao.retry")}
                </button>
                <button
                  type="button"
                  style={s.knowledgeSecondaryBtn}
                  onClick={() => onRemove(item.issue.id)}
                >
                  {t("plan.launch.remove")}
                </button>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
