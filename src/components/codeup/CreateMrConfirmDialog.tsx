import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { GitBranch, Send, X } from "lucide-react";
import type { PendingBranchCandidate } from "../../types";
import { ReviewerPicker } from "./ReviewerPicker";

/** 弹层里最多列出的分支条数：再多也会被折叠成「其余 N 个」。 */
export const MAX_CREATE_LINES = 15;

/**
 * 批量发起合并请求前的确认弹层。
 *
 * 与删除确认同构（应用内 Radix 弹层、主题跟随、逐条列出分支与目标分支），但性质不同：
 * 发起 MR 是**幂等**的（同源 + 同目标已有开放 MR 会被后端跳过），所以这里不做 dry-run，
 * 只让用户核对「哪些分支 → 哪个目标分支」与审核人。
 *
 * 审核人用成员选择器（对齐云效「添加成员」）：默认勾选目标分支保护规则里的默认评审人，
 * 可搜索勾选、也可手填。值以人名传递，后端发起时解析成云效用户 ID。
 */
export function CreateMrConfirmDialog({
  pending,
  busy,
  reviewers,
  recommendedReviewers,
  onReviewersChange,
  onCancel,
  onConfirm,
}: {
  /** 待发起项；`null` 表示弹层关闭。 */
  pending: PendingBranchCandidate[] | null;
  busy: boolean;
  /** 已选审核人（人名）。 */
  reviewers: string[];
  /** 目标分支保护规则里的默认评审人（置顶并标「推荐」）。 */
  recommendedReviewers: string[];
  onReviewersChange: (value: string[]) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const candidates = pending ?? [];
  const visible = candidates.slice(0, MAX_CREATE_LINES);
  const hidden = candidates.length - visible.length;
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        // 发起进行中不允许关掉弹层（后端已经在推分支了）。
        if (!open && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="build-dialog-overlay" />
        <Dialog.Content
          ref={contentRef}
          className="build-dialog"
          aria-describedby="pm-create-lead"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <div className="build-dialog-head">
            <span className="build-dialog-icon">
              <Send size={15} />
            </span>
            <Dialog.Title className="build-dialog-title">发起合并请求</Dialog.Title>
            <Dialog.Close className="build-dialog-close" aria-label="关闭" disabled={busy}>
              <X size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="build-dialog-lead" id="pm-create-lead">
            将在云效上发起 <strong>{candidates.length}</strong> 个合并请求：
          </Dialog.Description>
          <div className="build-dialog-list">
            {visible.map((c) => (
              <div key={`${c.repoPath}:${c.branch}`} className="build-dialog-item">
                <span className="build-dialog-item-name">
                  <GitBranch size={11} />
                  <span className="build-dialog-item-repo">{c.repo}</span>
                  <span className="build-dialog-item-sep">:</span>
                  <span className="build-dialog-item-branch">{c.branch}</span>
                </span>
                <span className="build-dialog-item-reason">目标分支 {c.targetBranch}</span>
              </div>
            ))}
            {hidden > 0 && <div className="build-dialog-more">… 其余 {hidden} 个</div>}
          </div>
          <div className="build-dialog-note">
            <label className="pm-dialog-field">
              <span>审核人（默认目标分支的评审人，可搜索添加）</span>
              <ReviewerPicker
                value={reviewers}
                onChange={onReviewersChange}
                recommended={recommendedReviewers}
                disabled={busy}
              />
            </label>
            <p>发起前会先把源分支非强制推送到远端；已有同源 + 同目标开放 MR 的分支会自动跳过。</p>
          </div>
          <div className="build-dialog-actions">
            <button className="rp-btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button className="rp-btn" data-variant="primary" onClick={onConfirm} disabled={busy}>
              <Send size={12} />
              {busy ? "发起中…" : `发起 ${candidates.length} 个合并请求`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
