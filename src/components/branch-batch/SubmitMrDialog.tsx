import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send, X } from "lucide-react";
import type { DeliveryPlan } from "../../types";
import { ReviewerPicker } from "../codeup/ReviewerPicker";

export function SubmitMrDialog({
  projectPath,
  projectId,
  batch,
  onDone,
  onClose,
}: {
  projectPath: string;
  projectId: string;
  batch: DeliveryPlan;
  onDone: () => void;
  onClose: () => void;
}) {
  /** 审核人（人名）。与「发起合并请求」弹层同一套选择器，由后端解析成云效用户 ID。 */
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [recommended, setRecommended] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 目标分支留空：弹层虽打不开此路径，仍给出可见原因（兜底，不做静默 return）。 */
  const missingTarget = !batch.targetBranch.trim();

  useEffect(() => {
    // 目标分支留空的批不能提交 MR（后端同口径拦截）；按钮禁用并给出提示。
    if (!batch.targetBranch.trim()) return;
    // 默认审核人 = 目标分支的默认评审人。按批所属仓库查（与提交 MR 同一仓库），
    // 否则多子仓库工作区会拿主仓库的保护规则，预填出另一批审核人。
    void invoke<string[]>("codeup_branch_managers", {
      projectPath,
      repoPath: batch.worktreeRepo ?? null,
      targetBranch: batch.targetBranch,
    })
      .then((managers) => {
        setRecommended(managers);
        setReviewers(managers);
      })
      .catch((e) => console.warn("[submit-mr] load reviewers failed:", e));
  }, [projectPath, batch.worktreeRepo, batch.targetBranch]);

  const submit = useCallback(async () => {
    if (missingTarget) {
      setError("未指定合并回目标分支，无法提交 MR；请先在计划详情补记目标分支");
      return;
    }
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await invoke("codeup_create_mr", {
        projectPath,
        repoPath: batch.worktreeRepo ?? null,
        projectId,
        planId: batch.id,
        reviewers,
      });
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, missingTarget, reviewers, projectPath, projectId, batch.id, batch.worktreeRepo, onDone, onClose]);

  return (
    <div className="build-dialog-overlay">
      <div className="build-dialog pm-submit-dialog">
        <div className="build-dialog-head">
          <span className="build-dialog-icon">
            <Send size={15} />
          </span>
          <span className="build-dialog-title">提交合并请求</span>
          <button type="button" className="build-dialog-close" aria-label="关闭" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div className="pm-submit-branch">
          <code>{batch.branch}</code>
          <span>→ {batch.targetBranch || "（未指定合并目标）"}</span>
        </div>

        <label className="pm-dialog-field">
          <span>审核人（默认目标分支的评审人，可搜索添加）</span>
          <ReviewerPicker
            value={reviewers}
            onChange={setReviewers}
            recommended={recommended}
            disabled={busy}
          />
        </label>

        <div className="pm-dialog-field">
          <span>说明</span>
          <div className="pm-submit-summary">
            标题：{batch.name}；来源：{batch.branch}；目标：{batch.targetBranch}
          </div>
        </div>

        <div className="build-dialog-actions">
          <button className="rp-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="rp-btn"
            data-variant="primary"
            disabled={busy || !batch.targetBranch.trim()}
            title={batch.targetBranch.trim() ? undefined : "未指定合并回目标分支，无法提交 MR"}
            onClick={() => void submit()}
          >
            <Send size={12} />
            {busy ? "提交中…" : "提交到 Codeup"}
          </button>
        </div>

        {error && <div className="pm-submit-error">{error}</div>}
      </div>
    </div>
  );
}
