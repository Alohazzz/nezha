import { useState } from "react";
import { Check, Cloud, Loader2 } from "lucide-react";
import type { YunxiaoWorkitem } from "../../types";
import { getYunxiaoPriority } from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import s from "../../styles";

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
  onImport,
  onLoadMore,
}: {
  issues: YunxiaoWorkitem[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  importedIds: ReadonlySet<string>;
  onImport: (issue: YunxiaoWorkitem) => void;
  onLoadMore: () => void;
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
          const priority = getYunxiaoPriority(issue);
          const meta: string[] = [
            issue.status?.displayName ?? issue.status?.name ?? t("yunxiao.statusUnknown"),
          ];
          if (priority) meta.push(priority);
          if (issue.assignedTo) meta.push(issue.assignedTo.name);
          const date = formatDate(issue.gmtCreate);
          if (date) meta.push(date);

          return (
            <div
              key={issue.id}
              style={hover ? s.yunxiaoIssueCardHover : s.yunxiaoIssueCard}
              onMouseEnter={() => setHoverIssueId(issue.id)}
              onMouseLeave={() => setHoverIssueId(null)}
            >
              <span style={s.yunxiaoIssueSerial}>{issue.serialNumber}</span>
              <div style={s.yunxiaoIssueBody}>
                <div style={s.yunxiaoIssueSubject}>{issue.subject}</div>
                <div style={s.yunxiaoIssueMeta}>
                  {meta.map((m) => (
                    <span key={m} style={s.yunxiaoMetaBadge}>
                      {m}
                    </span>
                  ))}
                </div>
              </div>
              {imported ? (
                <span style={s.yunxiaoImportedBadge}>
                  <Check size={12} strokeWidth={2.5} />
                  {t("yunxiao.imported")}
                </span>
              ) : (
                <button
                  type="button"
                  style={hover ? s.yunxiaoImportBtnHover : s.yunxiaoImportBtn}
                  onClick={() => onImport(issue)}
                >
                  {t("yunxiao.import")}
                </button>
              )}
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