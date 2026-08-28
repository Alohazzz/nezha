import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Download, GitMerge, Play, RefreshCw, X } from "lucide-react";
import type { CodeupMr, CodeupRepository } from "../../types";
import s from "../../styles";

interface ReviewFinding {
  rule: string;
  status: string;
  path: string;
  startLine: number;
  endLine: number;
  message: string;
}

interface ReviewState {
  running: boolean;
  findings: ReviewFinding[];
  error: string;
}

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
  const [reviews] = useState<Record<string, ReviewState>>({});
  const [busyId, setBusyId] = useState("");

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
    await onStartCodeupTask(mr, "review");
  }, [onStartCodeupTask]);

  const pullCode = useCallback(async (mr: CodeupMr) => {
    setBusyId(mr.id);
    setNotice("");
    try {
      const path = await invoke<string>("codeup_pull_code", {
        repository: mr.repository,
        sourceBranch: mr.sourceBranch,
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
    }
  }, []);

  const resolveConflicts = useCallback(async (mr: CodeupMr) => {
    await onStartCodeupTask(mr, "conflict");
  }, [onStartCodeupTask]);

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
            {reviews[mr.id]?.error && <div style={s.bbGateHint}>{reviews[mr.id]?.error}</div>}
            {reviews[mr.id]?.findings.map((f, i) => (
              <div key={i} style={s.bbCardSub}>
                {f.status === "fail" ? (
                  <span style={s.bbBadgeConflict}>fail</span>
                ) : (
                  <span style={s.bbBadgeDone}>ok</span>
                )}
                <span style={s.bbCardMono}>
                  {f.path}:{f.startLine}
                </span>
                <span>{f.message}</span>
              </div>
            ))}
            <div style={s.bbCardActions}>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={mr.pulled || busyId === mr.id}
                onClick={() => void pullCode(mr)}
              >
                <Download size={13} />
                {mr.pulled ? "已拉取" : "拉取代码"}
              </button>
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={reviews[mr.id]?.running}
                onClick={() => void runReview(mr)}
              >
                <Play size={13} />
                {reviews[mr.id]?.running ? "审查中…" : "代码审查"}
              </button>
              {mr.hasConflict && (
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={busyId === mr.id}
                  onClick={() => void resolveConflicts(mr)}
                >
                  <GitMerge size={13} />
                  处理冲突
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
