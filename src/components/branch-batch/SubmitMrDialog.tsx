import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Send, X } from "lucide-react";
import type { BranchBatch } from "../../types";
import s from "../../styles";

export function SubmitMrDialog({
  projectPath,
  projectId,
  batch,
  onDone,
  onClose,
}: {
  projectPath: string;
  projectId: string;
  batch: BranchBatch;
  onDone: () => void;
  onClose: () => void;
}) {
  const [reviewers, setReviewers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // 默认审核人 = 目标分支保护规则的管理人员。
    void invoke<string[]>("codeup_branch_managers", {
      projectPath,
      repoPath: null,
      targetBranch: batch.targetBranch,
    })
      .then((managers) => setReviewers(managers.join(", ")))
      .catch((e) => console.warn("[submit-mr] load managers failed:", e));
  }, [projectPath, batch.targetBranch]);

  const submit = useCallback(async () => {
    if (!batch.targetBranch.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const list = reviewers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await invoke("codeup_create_mr", {
        projectPath,
        repoPath: batch.worktreeRepo ?? null,
        projectId,
        batchId: batch.id,
        reviewers: list,
      });
      onDone();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, reviewers, projectPath, projectId, batch.id, batch.targetBranch, batch.worktreeRepo, onDone, onClose]);

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.bbDialog}>
        <div style={s.bbDialogTitle}>
          提交合并请求
          <div style={s.bbFill} />
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <div style={s.bbCardSub}>
          <span style={s.bbCardMono}>{batch.branch}</span>
          <span>→ {batch.targetBranch}</span>
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>审核人（默认目标分支管理人员，可编辑，逗号分隔）</span>
          <textarea
            style={s.bbInput}
            value={reviewers}
            onChange={(e) => setReviewers(e.target.value)}
            rows={3}
            placeholder="如：张三, 李四"
          />
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>说明</span>
          <input
            style={s.bbInput}
            disabled
            value={`标题：${batch.name}；来源：${batch.branch}；目标：${batch.targetBranch}`}
          />
        </div>

        <div style={s.bbField}>
          <button type="button" style={s.bbBtnPrimary} disabled={busy} onClick={() => void submit()}>
            <Send size={13} />
            {busy ? "提交中…" : "提交到 Codeup"}
          </button>
        </div>

        {error && <div style={s.bbGateHint}>{error}</div>}
      </div>
    </div>
  );
}
