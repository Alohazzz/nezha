import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { renderMarkdownWithToc } from "../../utils/markdown";
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
      <span style={s.statAccent} />
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
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const week = mondayForOffset(offset);
    setError(null);
    setReport(null);
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(true);
    invoke<WeeklyReport>("build_weekly_report", { week })
      .then((r) => { if (alive) setReport(r); })
      .catch((e) => { if (alive) setError(String(e)); });
    invoke<string>("generate_weekly_summary", { week })
      .then((s) => { if (alive) { setSummary(s); setSummaryLoading(false); } })
      .catch((e) => { if (alive) { setSummaryError(String(e)); setSummaryLoading(false); } });
    return () => { alive = false; };
  }, [offset]);

  const summaryHtml = useMemo(
    () => (summary ? renderMarkdownWithToc(summary).html : ""),
    [summary],
  );

  const copyMd = () => {
    if (report?.markdown) navigator.clipboard.writeText(report.markdown);
  };

  const generateSummary = () => {
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(true);
    invoke<string>("generate_weekly_summary", { week: mondayForOffset(offset) })
      .then((s) => { setSummary(s); setSummaryLoading(false); })
      .catch((e) => { setSummaryError(String(e)); setSummaryLoading(false); });
  };

  return (
    <div style={s.pane}>
      <div style={s.inner}>
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

        <div style={s.summaryCard}>
          <div style={s.summaryHead}>
            <div style={s.summaryTitle}>{t("weekly.summaryTitle")}</div>
            <button style={s.btn} onClick={generateSummary} disabled={summaryLoading || !report}>
              {summary ? t("weekly.summaryRegenerate") : t("weekly.summaryGenerate")}
            </button>
          </div>
          {summaryLoading ? (
            <div style={s.hint}>{t("weekly.summaryLoading")}</div>
          ) : summary ? (
            <div className="md-preview" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
          ) : summaryError ? (
            <div style={s.hint}>{t("weekly.summaryError", { error: summaryError })}</div>
          ) : (
            <div style={s.hint}>{t("weekly.summaryEmpty")}</div>
          )}
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
              report.by_project.map((p) => {
                const hasCommits = p.commits.length > 0;
                const items = hasCommits
                  ? p.commits.map((c) => ({
                      key: `${c.date}-${c.subject}`,
                      date: c.date,
                      title: c.subject,
                      chip: null as string | null,
                    }))
                  : p.days.map((d) => ({
                      key: d.date,
                      date: d.date,
                      title: d.topics.length > 0 ? d.topics.join(" · ") : t("weekly.noTopic"),
                      chip: t("weekly.sessionsCount", { count: d.count }),
                    }));
                return (
                  <div style={s.group} key={p.project}>
                    <div style={s.groupHead}>
                      <div style={s.avatar}>{p.project[0]?.toUpperCase() ?? "?"}</div>
                      <div style={s.groupName}>{p.project}</div>
                      <div style={s.groupSub}>
                        {hasCommits
                          ? t("weekly.commitsCount", { count: p.commits.length })
                          : t("weekly.daysCount", { count: p.days.length })}
                      </div>
                      <div style={s.badge}>
                        {t("weekly.sessionsCount", { count: p.sessions })}
                      </div>
                    </div>
                    <div style={s.rows}>
                      {items.map((it) => (
                        <div style={s.row} key={it.key}>
                          <span style={s.datePill}>{it.date}</span>
                          <span style={s.dot} />
                          <div style={s.rowTitle}>{it.title}</div>
                          {it.chip ? <span style={s.chip}>{it.chip}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
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
    </div>
  );
}
