import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Download, FileText, GitMerge, Play, RefreshCw, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { CodeupMr, CodeupRepository } from "../../types";
import s from "../../styles";

const STATUS_LABEL: Record<string, string> = {
  UNDER_REVIEW: "评审中",
  MERGED: "已合并",
  CLOSED: "已关闭",
  APPROVED: "已通过",
};

function statusBadge(state: string) {
  if (state === "MERGED" || state === "APPROVED") return s.bbBadgeDone;
  if (state === "CLOSED") return s.bbBadge;
  return s.bbBadgeActive;
}

export function MergeHubView({
  onBack,
  onStartCodeupTask,
}: {
  onBack: () => void;
  onStartCodeupTask: (mr: CodeupMr, kind: "review" | "conflict") => void | Promise<void>;
}) {
  const [repos, setRepos] = useState<CodeupRepository[]>([]);
  const [repoFilter, setRepoFilter] = useState("");
  const [mrs, setMrs] = useState<CodeupMr[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState("");
  const [busyAction, setBusyAction] = useState<"" | "pull" | "review" | "conflict">("");
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

  const act = useCallback(
    async (kind: "approve" | "merge", mr: CodeupMr) => {
      setNotice("");
      try {
        await invoke<string>(kind === "approve" ? "codeup_approve_mr" : "codeup_merge_mr", {
          repositoryId: mr.repositoryId,
          mrId: String(mr.localId),
          mergeType: "merge",
        });
        setNotice(kind === "approve" ? "已通过该合并请求。" : "已合并该合并请求。");
        await load(repoFilter);
      } catch (e) {
        setNotice(String(e));
      }
    },
    [load, repoFilter],
  );

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

  const resolveConflicts = useCallback(async (mr: CodeupMr) => {
    setBusyId(mr.id);
    setBusyAction("conflict");
    setNotice("");
    try {
      await onStartCodeupTask(mr, "conflict");
    } catch (e) {
      setNotice(String(e));
    } finally {
      setBusyId("");
      setBusyAction("");
    }
  }, [onStartCodeupTask]);

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
          <RefreshCw size={13} />
          刷新
        </button>
      </div>

      {notice && <div style={s.bbGateHint}>{notice}</div>}
      {error && <div style={s.bbGateHint}>{error}</div>}

      <div style={s.bbList}>
        {!loading && mrs.length === 0 && (
          <div style={s.bbEmpty}>当前无待你审核的合并请求。</div>
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
              {mr.hasConflict && (
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={busyId === mr.id}
                  onClick={() => void resolveConflicts(mr)}
                >
                  <GitMerge size={13} />
                  {busyAction === "conflict" && busyId === mr.id ? "处理中…" : "处理冲突"}
                </button>
              )}
              <button
                type="button"
                style={s.bbBtnGhost}
                onClick={() => void act("approve", mr)}
              >
                <CheckCircle2 size={13} />
                通过
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                onClick={() => void act("merge", mr)}
              >
                <GitMerge size={13} />
                合并
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
