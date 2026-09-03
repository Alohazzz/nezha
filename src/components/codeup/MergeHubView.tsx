import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, FileText, GitMerge, Play, RefreshCw, X } from "lucide-react";
import { confirm, save } from "@tauri-apps/plugin-dialog";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { CodeupMr, CodeupRepository } from "../../types";
import s from "../../styles";

const STATUS_LABEL: Record<string, string> = {
  UNDER_REVIEW: "评审中",
  TO_BE_MERGED: "待合并",
  MERGED: "已合并",
  CLOSED: "已关闭",
  APPROVED: "已通过",
};

function statusBadge(state: string) {
  if (state === "MERGED" || state === "APPROVED") return s.bbBadgeDone;
  if (state === "TO_BE_MERGED") return s.bbBadgeWarn;
  if (state === "CLOSED") return s.bbBadge;
  return s.bbBadgeActive;
}

export function MergeHubView({
  onBack,
  onStartCodeupTask,
}: {
  onBack: () => void;
  onStartCodeupTask: (mr: CodeupMr, kind: "review" | "conflict" | "merge") => void | Promise<void>;
}) {
  const [repos, setRepos] = useState<CodeupRepository[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [mrs, setMrs] = useState<CodeupMr[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [busyAction, setBusyAction] = useState<"" | "pull" | "review" | "merge">("");
  const [reviewModal, setReviewModal] = useState<{
    mr: CodeupMr;
    content: string;
    loading: boolean;
    error: string;
  } | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      const list = await invoke<CodeupRepository[]>("codeup_list_repositories");
      setRepos(list);
    } catch (e) {
      console.warn("[merge-hub] load repos failed:", e);
    }
  }, []);

  const load = useCallback(async (repoId: string) => {
    setLoading(true);
    setError("");
    try {
      const list = await invoke<CodeupMr[]>("codeup_list_pending_mrs", {
        repositoryId: repoId || null,
      });
      setMrs(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    void load(repoFilter);
  }, [repoFilter, load]);

  const runReview = useCallback(async (mr: CodeupMr) => {
    setBusyId(mr.id);
    setBusyAction("review");
    setNotice("");
    try {
      await onStartCodeupTask(mr, "review");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusyId("");
      setBusyAction("");
    }
  }, [onStartCodeupTask]);

  const pullCode = useCallback(async (mr: CodeupMr) => {
    setBusyId(mr.id);
    setBusyAction("pull");
    setNotice("");
    try {
      const path = await invoke<string>("codeup_pull_code", {
        repository: mr.repository,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        mrId: String(mr.localId),
      });
      setMrs((prev) =>
        prev.map((m) => (m.id === mr.id ? { ...m, pulled: true, worktreePath: path } : m)),
      );
      setNotice("已拉取代码到本地 worktree。");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusyId("");
      setBusyAction("");
    }
  }, []);

  const startMerge = useCallback(
    async (mr: CodeupMr) => {
      setNotice("");
      if (!mr.pulled) {
        setNotice("请先拉取代码，再执行分支合并。");
        return;
      }
      // 非阻塞安全网：若该 MR 当前审查报告存在 fail（阻止级）标记，弹一次确认提示。
      try {
        const report = await invoke<string | null>("codeup_read_review_report", {
          repository: mr.repository,
          mrId: String(mr.localId),
        });
        if (report) {
          const failCount = (report.match(/\bfail\b/gi) ?? []).length;
          if (failCount > 0) {
            const ok = await confirm(
              `审查报告存在 ${failCount} 处 fail（阻止级）标记，仍要交给 Agent 合并？`,
              { title: "合并确认", kind: "warning" },
            );
            if (!ok) return;
          }
        }
      } catch {
        // 读不到报告则不做额外确认，直接交给 Agent 合并。
      }
      setBusyId(mr.id);
      setBusyAction("merge");
      try {
        await onStartCodeupTask(mr, "merge");
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId("");
        setBusyAction("");
      }
    },
    [onStartCodeupTask],
  );

  const exportReview = useCallback(async () => {
    if (!reviewModal?.content) return;
    const destPath = await save({
      defaultPath: `review-report-${reviewModal.mr.localId}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!destPath) return;
    try {
      await invoke("codeup_export_review_report", {
        repository: reviewModal.mr.repository,
        mrId: String(reviewModal.mr.localId),
        destPath,
      });
      setNotice(`审查报告已导出到 ${destPath}`);
    } catch (e) {
      setNotice(String(e));
    }
  }, [reviewModal]);

  const copyReview = useCallback(async () => {
    if (!reviewModal?.content) return;
    try {
      await navigator.clipboard.writeText(reviewModal.content);
      setNotice("审查报告全文已复制到剪贴板。");
    } catch (e) {
      setNotice(String(e));
    }
  }, [reviewModal]);

  const openReview = useCallback(async (mr: CodeupMr) => {
    setReviewModal({ mr, content: "", loading: true, error: "" });
    setNotice("");
    try {
      const report = await invoke<string | null>("codeup_read_review_report", {
        repository: mr.repository,
        mrId: String(mr.localId),
      });
      setReviewModal((prev) =>
        prev?.mr.id === mr.id
          ? {
              ...prev,
              content: report ?? "",
              loading: false,
              error: report ? "" : "该 MR 暂无审查报告，请先执行「代码审查」。",
            }
          : prev,
      );
    } catch (e) {
      setReviewModal((prev) =>
        prev?.mr.id === mr.id ? { ...prev, loading: false, error: String(e) } : prev,
      );
    }
  }, []);

  // 报告是 Markdown，渲染为 sanitized HTML 后以 .md-preview 排版，避免直接铺开卡片导致错乱。
  const reviewReportHtml = useMemo(
    () =>
      reviewModal?.content
        ? DOMPurify.sanitize(marked.parse(reviewModal.content, { async: false }) as string)
        : "",
    [reviewModal?.content],
  );

  return (
    <div style={s.welcomePane}>
      <div style={s.bbHeader}>
        <button type="button" style={s.bbBackBtn} onClick={onBack}>
          <X size={14} />
          返回
        </button>
        <div style={s.bbFill} />
        <select
          style={s.bbInput}
          value={repoFilter}
          onChange={(e) => setRepoFilter(e.target.value)}
        >
          <option value="">全部仓库</option>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.namespace || r.name}
            </option>
          ))}
        </select>
        <button type="button" style={s.bbBtnGhost} onClick={() => void load(repoFilter)} disabled={loading}>
          <RefreshCw size={13} className={loading ? "spin" : undefined} />
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {notice && <div style={s.bbGateHint}>{notice}</div>}
      {error && <div style={s.bbGateHint}>{error}</div>}
      {loading && mrs.length > 0 && (
        <div style={s.bbRefreshing}>
          <RefreshCw size={13} className="spin" />
          正在刷新合并请求…
        </div>
      )}
      {busyId && (
        <div style={s.bbRefreshing}>
          <RefreshCw size={13} className="spin" />
          正在执行：
          {busyAction === "pull" ? "拉取代码" : busyAction === "review" ? "代码审查" : busyAction === "merge" ? "分支合并" : "操作"}…
        </div>
      )}

      <div style={s.bbList}>
        {loading && mrs.length === 0 && (
          <div style={s.bbRefreshing}>
            <RefreshCw size={16} className="spin" />
            正在加载合并请求…
          </div>
        )}
        {!loading && mrs.length === 0 && (
          <div style={s.bbEmpty}>当前无待处理或待合并的合并请求。</div>
        )}
        {mrs.map((mr) => (
          <div key={mr.id} style={s.bbCard}>
            <div style={s.bbCardHead}>
              <span style={s.bbCardTitle}>{mr.title}</span>
              <span style={statusBadge(mr.status)}>{STATUS_LABEL[mr.status] ?? mr.status}</span>
              {mr.hasConflict && <span style={s.bbBadgeConflict}>有冲突</span>}
              <span style={s.bbBadge}>{mr.repository}</span>
              <div style={s.bbFill} />
            </div>
            <div style={s.bbCardSub}>
              <span style={s.bbCardMono}>{mr.sourceBranch}</span>
              <span>→ {mr.targetBranch}</span>
              <span>{mr.author ? `作者：${mr.author}` : ""}</span>
            </div>
            {mr.reviewers.length > 0 && (
              <div style={s.bbCardSub}>
                <span style={s.bbCardMono}>审核人：{mr.reviewers.join(", ")}</span>
              </div>
            )}
            <div style={s.bbCardActions}>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={mr.pulled || busyId === mr.id}
                onClick={() => void pullCode(mr)}
              >
                <Download size={13} />
                {busyAction === "pull" && busyId === mr.id
                  ? "拉取中…"
                  : mr.pulled
                    ? "已拉取"
                    : "拉取代码"}
              </button>
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={busyId === mr.id}
                onClick={() => void runReview(mr)}
              >
                <Play size={13} />
                {busyAction === "review" && busyId === mr.id ? "审查中…" : "代码审查"}
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={busyId === mr.id}
                onClick={() => void startMerge(mr)}
              >
                <GitMerge size={13} />
                {busyAction === "merge" && busyId === mr.id ? "合并中…" : "分支合并"}
              </button>
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={busyId === mr.id}
                onClick={() => void openReview(mr)}
              >
                <FileText size={13} />
                查看审查结果
              </button>
            </div>
          </div>
        ))}
      </div>

      {reviewModal && (
        <div style={s.bbDialogOverlay} onMouseDown={() => setReviewModal(null)}>
          <div
            style={s.bbReviewDialog}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div style={s.bbReviewDialogHead}>
              <span style={s.bbReviewDialogTitle}>{reviewModal.mr.title}</span>
              <div style={s.bbReviewActions}>
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={!reviewModal.content}
                  onClick={() => void copyReview()}
                >
                  复制
                </button>
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={!reviewModal.content}
                  onClick={() => void exportReview()}
                >
                  <Download size={13} />
                  导出 .md
                </button>
              </div>
              <button
                type="button"
                title="关闭"
                aria-label="关闭"
                onClick={() => setReviewModal(null)}
                style={s.bbReviewCloseBtn}
              >
                <X size={14} />
              </button>
            </div>
            <div style={s.bbReviewDialogBody}>
              {reviewModal.loading ? (
                <div style={s.bbEmpty}>加载中…</div>
              ) : reviewModal.error ? (
                <div style={s.bbGateHint}>{reviewModal.error}</div>
              ) : reviewModal.content ? (
                <div
                  className="md-preview"
                  dangerouslySetInnerHTML={{ __html: reviewReportHtml }}
                />
              ) : (
                <div style={s.bbGateHint}>该 MR 暂无审查报告，请先执行「代码审查」。</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
