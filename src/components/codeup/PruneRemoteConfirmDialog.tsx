import { useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, GitBranch, X } from "lucide-react";
import type { PendingRemoteBranchTarget } from "../../types";

/** 确认框里最多列出的分支条数：再多也会被折叠成「其余 N 个」。 */
export const MAX_CONFIRM_LINES = 15;

/**
 * 删除远端分支前的确认框。
 *
 * 用应用内 Radix 弹层而不是 `plugin-dialog` 的原生 `confirm()`：原生框吃不下长分支名
 * （等宽换行后读不出边界），也不跟随 Nezha 主题。先例见 `StaleBranchCleanup`。
 *
 * 确认框里逐条给出分支名与目标分支——删除是对外可见且难以撤销的操作，不能让用户
 * 在没看清删哪条的情况下点头。
 */
export function PruneRemoteConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  /** 待删除项；`null` 表示弹层关闭。 */
  pending: PendingRemoteBranchTarget[] | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const candidates = pending ?? [];
  const visible = candidates.slice(0, MAX_CONFIRM_LINES);
  const hidden = candidates.length - visible.length;
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        // 删除进行中不允许关掉弹层（后端已经在动远端分支了）。
        if (!open && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="build-dialog-overlay" />
        <Dialog.Content
          ref={contentRef}
          className="build-dialog"
          aria-describedby="pm-dialog-lead"
          // 焦点落在弹层容器本身：避免打开瞬间给关闭按钮画一圈「被选中」的焦点环，
          // 也避免回车直接命中删除按钮。Tab 照常进入按钮序列。
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <div className="build-dialog-head">
            <span className="build-dialog-icon">
              <AlertTriangle size={15} />
            </span>
            <Dialog.Title className="build-dialog-title">删除远端分支</Dialog.Title>
            <Dialog.Close className="build-dialog-close" aria-label="关闭" disabled={busy}>
              <X size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="build-dialog-lead" id="pm-dialog-lead">
            将从远端删除 <strong>{candidates.length}</strong> 个分支（本地分支不受影响）：
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
            <p>删除对外可见且难以撤销：只删除已完整合并进目标分支的远端分支。</p>
            <p>未完成合并、受保护或未推送的分支会被后端硬性拒绝；本地分支不会被删除。</p>
          </div>
          <div className="build-dialog-actions">
            <button className="rp-btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button className="rp-btn" data-variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? "删除中…" : `删除 ${candidates.length} 个远端分支`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
