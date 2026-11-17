import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, GitMerge, RefreshCw, Search } from "lucide-react";
import type { CodeupMr } from "../../types";
import { mergeHubStyles } from "../../styles";
import { useMergeHub, type StartCodeupTask } from "./merge-hub/useMergeHub";
import { MergeDetail, MrStatus } from "./merge-hub/MergeDetail";
import { CloseMrDialog } from "./merge-hub/CloseMrDialog";
import { ReviewReportDialog } from "./merge-hub/ReviewReportDialog";
import { RepositoryFilter } from "./merge-hub/RepositoryFilter";
const PAGE_SIZE = 50;
export function MergeHubView({
  onBack,
  onStartCodeupTask,
}: {
  onBack: () => void;
  onStartCodeupTask: StartCodeupTask;
}) {
  const hub = useMergeHub(onStartCodeupTask);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(0);
  const [closing, setClosing] = useState<CodeupMr | null>(null);
  const [report, setReport] = useState<CodeupMr | null>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return hub.mrs.filter((mr) =>
      `${mr.title} ${mr.repository} ${mr.sourceBranch} ${mr.targetBranch} ${mr.author} #${mr.localId}`
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [hub.mrs, query]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const current = visible.find((mr) => mr.id === selected) ?? visible[0];
  const blocked = !!hub.busy || !!closing;
  function resetSelection() {
    setPage(0);
    setSelected("");
  }
  return (
    <section className="mh-root" aria-label="合并审核">
      <style>{mergeHubStyles}</style>
      <header className="mh-top">
        <button className="mh-button mh-back" onClick={onBack} disabled={blocked}>
          <ArrowLeft size={14} />
          返回
        </button>
        <span>工作空间 / 合并审核</span>
      </header>
      <div className="mh-body">
        <div className="mh-heading">
          <div>
            <div className="mh-eyebrow">CODE REVIEW</div>
            <h1>合并审核</h1>
            <p>从代码审查到分支合并，让每一次交付都有据可循。</p>
          </div>
          <button className="mh-button" disabled={hub.loading || blocked} onClick={hub.refresh}>
            <RefreshCw size={14} className={hub.loading ? "spin" : undefined} />
            {hub.loading ? "刷新中…" : "刷新"}
          </button>
        </div>
        <div className="mh-summary">
          <span>
            <b>{hub.loading ? "—" : hub.mrs.length}</b>
            {hub.state === "opened" ? "待处理" : "最近已关闭"}
          </span>
          {hub.state === "opened" && (
            <>
              <span>
                <b>
                  {hub.loading
                    ? "—"
                    : hub.mrs.filter((m) => m.status === "TO_BE_MERGED" || m.status === "APPROVED")
                        .length}
                </b>
                待合并
              </span>
              <span>
                <b>{hub.loading ? "—" : hub.mrs.filter((m) => m.hasConflict).length}</b>存在冲突
              </span>
            </>
          )}
        </div>
        <div className="mh-tools">
          <div className="mh-tabs" aria-label="请求状态">
            {(
              [
                ["opened", "待处理"],
                ["closed", "已关闭"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className="mh-button"
                aria-pressed={hub.state === value}
                disabled={blocked}
                onClick={() => {
                  hub.setState(value);
                  resetSelection();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mh-filters">
            <label className="mh-search">
              <Search size={14} />
              <input
                aria-label="搜索合并请求"
                placeholder="搜索标题、仓库或分支…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  resetSelection();
                }}
              />
            </label>
            <RepositoryFilter
              repos={hub.repos}
              value={hub.repoFilter}
              disabled={blocked}
              onChange={(value) => {
                hub.setRepoFilter(value);
                resetSelection();
              }}
            />
          </div>
        </div>
        {hub.repoError && (
          <div className="mh-message mh-error" role="alert">
            {hub.repoError}
          </div>
        )}
        {hub.error && (
          <div className="mh-message mh-error" role="alert">
            {hub.error}
            <button className="mh-button" disabled={blocked || hub.loading} onClick={hub.refresh}>
              重试
            </button>
          </div>
        )}
        {hub.notice && (
          <div className="mh-message" role="status">
            {hub.notice}
          </div>
        )}
        {hub.loading ? (
          <div className="mh-empty" role="status">
            <RefreshCw size={24} className="spin" />
            <h3>正在加载合并请求…</h3>
          </div>
        ) : hub.error ? null : !current ? (
          <div className="mh-empty">
            <GitMerge size={30} />
            <h3>
              {query
                ? "没有匹配的合并请求"
                : hub.state === "closed"
                  ? "暂无已关闭的合并请求"
                  : "当前没有待处理的合并请求"}
            </h3>
            <p>{query ? "试试其他标题、仓库或分支。" : "可切换状态、仓库或刷新列表。"}</p>
          </div>
        ) : (
          <>
            <div className="mh-split">
              <div className="mh-inbox" aria-label="合并请求列表">
                {visible.map((mr) => (
                  <button
                    className="mh-inbox-item"
                    key={mr.id}
                    aria-pressed={mr.id === current.id}
                    onClick={() => setSelected(mr.id)}
                  >
                    <span className="mh-meta">
                      <span>
                        {mr.repository} #{mr.localId}
                      </span>
                      <span>{mr.author || "未知作者"}</span>
                    </span>
                    <h3>{mr.title}</h3>
                    <span
                      className="mh-inbox-branches"
                      title={`${mr.sourceBranch} → ${mr.targetBranch}`}
                    >
                      <code className="mh-inbox-source">{mr.sourceBranch}</code>
                      <ArrowRight size={13} aria-hidden="true" />
                      <span className="mh-inbox-target">
                        <span>合入</span>
                        <strong>{mr.targetBranch}</strong>
                      </span>
                    </span>
                    <span className="mh-row-status">
                      <MrStatus mr={mr} />
                      {mr.hasConflict && <span className="mh-conflict">存在冲突</span>}
                    </span>
                  </button>
                ))}
              </div>
              <MergeDetail
                mr={current}
                busy={hub.busy}
                onAction={(action) => void hub.run(current, action)}
                onReport={() => setReport(current)}
                onClose={() => setClosing(current)}
              />
            </div>
            <div className="mh-pagination">
              <span>
                已加载 {hub.mrs.length} 条 · 匹配 {filtered.length} 条
                {hub.mrs.length >= 1000 ? "（已达上限，请按仓库筛选）" : ""}
              </span>
              {lastPage > 0 && (
                <div>
                  <button
                    className="mh-button"
                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                  >
                    上一页
                  </button>
                  <span>
                    {currentPage + 1} / {lastPage + 1}
                  </span>
                  <button
                    className="mh-button"
                    disabled={currentPage === lastPage}
                    onClick={() => setPage(currentPage + 1)}
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {closing && (
        <CloseMrDialog
          mr={closing}
          onClose={() => setClosing(null)}
          onConfirm={() => hub.run(closing, "close")}
        />
      )}{" "}
      {report && (
        <ReviewReportDialog
          key={`${report.repositoryId}:${report.localId}`}
          mr={report}
          onClose={() => setReport(null)}
        />
      )}
    </section>
  );
}
