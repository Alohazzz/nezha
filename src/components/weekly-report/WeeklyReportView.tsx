import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BarChart3 } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { WeeklyReport } from "../../weeklyReport";

function mondayForOffset(offset: number): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = today.getDay(); // 0 Sun .. 6 Sat
  const diff = (dow === 0 ? -6 : 1 - dow) - offset * 7;
  const m = new Date(today);
  m.setDate(today.getDate() + diff);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${m.getFullYear()}-${pad(m.getMonth() + 1)}-${pad(m.getDate())}`;
}

function mergeStyle(base: CSSProperties, override?: CSSProperties | false): CSSProperties {
  return override ? { ...base, ...override } : base;
}

function Stat({ k, v, sub }: { k: string; v: ReactNode; sub?: string }) {
  return (
    <div style={s.stat}>
      <div style={s.statKey}>{k}</div>
      <div style={s.statValue}>{v}</div>
      {sub ? <div style={s.statSub}>{sub}</div> : null}
    </div>
  );
}

export function WeeklyReportView() {
  const { t } = useI18n();
  const [offset, setOffset] = useState(1); // default = last week
  const [report, setReport] = useState<WeeklyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    setReport(null);
    invoke<WeeklyReport>("build_weekly_report", { week: mondayForOffset(offset) })
      .then((r) => { if (alive) setReport(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, [offset]);

  const copyMd = () => {
    if (report?.markdown) navigator.clipboard.writeText(report.markdown);
  };

  return (
    <div style={s.pane}>
      <div style={s.header}>
        <div>
          <div style={s.headTitle}>{t("weekly.title")}</div>
          <div style={s.headSub}>
            {report
              ? t("weekly.subtitle", { start: report.week_start, end: report.week_end })
              : ""}
          </div>
        </div>
        <div style={s.actions}>
          <div style={s.seg}>
            <button
              style={mergeStyle(s.segBtn, offset === 0 && s.segActive)}
              onClick={() => setOffset(0)}
            >
              {t("weekly.thisWeek")}
            </button>
            <button
              style={mergeStyle(s.segBtn, offset === 1 && s.segActive)}
              onClick={() => setOffset(1)}
            >
              {t("weekly.lastWeek")}
            </button>
            <button
              style={mergeStyle(s.segBtn, offset === 2 && s.segActive)}
              onClick={() => setOffset(2)}
            >
              {t("weekly.weekBefore")}
            </button>
          </div>
          <button style={s.btn} onClick={copyMd} disabled={!report}>
            {t("weekly.copyMd")}
          </button>
          <button style={mergeStyle(mergeStyle(s.btn, s.btnPrimary), s.btnDisabled)} disabled>
            {t("weekly.reportUp")}
          </button>
        </div>
      </div>

      {error ? (
        <div style={s.hint}>{t("weekly.error", { error })}</div>
      ) : !report ? (
        <div style={s.hint}>{t("weekly.loading")}</div>
      ) : (
        <>
          <div style={s.stats}>
            <Stat k={t("weekly.sessions")} v={report.total_sessions} sub="agent 会话" />
            <Stat k={t("weekly.projects")} v={report.involved_projects} />
            <Stat k={t("weekly.gitCommits")} v={report.total_git} />
          </div>

          <div style={s.sectionLabel}>
            <span style={s.sectionDot} />
            {t("weekly.didThisWeek")}
          </div>
          {report.by_project.length === 0 ? (
            <div style={s.hint}>{t("weekly.noData")}</div>
          ) : (
            report.by_project.map((p) => (
              <div style={s.group} key={p.project}>
                <div style={s.groupHead}>
                  <div style={s.avatar}>{p.project[0]?.toUpperCase() ?? "?"}</div>
                  <div style={s.groupName}>{p.project}</div>
                  <div style={s.groupSub}>{p.days.length} 天</div>
                  <div style={s.badge}>{p.sessions}</div>
                  <BarChart3 size={14} style={s.icon} />
                </div>
                <div style={s.rows}>
                  {p.days.map((d) => (
                    <div style={s.row} key={d.date}>
                      <span style={s.date}>{d.date}</span>
                      <span style={s.dot} />
                      <div style={s.rowMain}>
                        <div style={s.rowTitle}>
                          {d.topics.length > 0 ? d.topics.join(" · ") : t("weekly.noTopic")}
                        </div>
                        <div style={s.rowMeta}>
                          <span style={s.chip}>
                            {t("weekly.sessionsCount", { count: d.count })}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}

          <div style={s.sectionLabel}>
            <span style={s.sectionDot} />
            {t("weekly.gitSection")}
          </div>
          <div style={s.gitGrid}>
            {report.git.map((g) => (
              <div style={s.gitCard} key={g.project}>
                <div style={s.gitName}>{g.project}</div>
                <div style={s.gitNum}>{g.count}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
