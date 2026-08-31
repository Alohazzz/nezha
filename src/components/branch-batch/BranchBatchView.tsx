import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Plus, RefreshCw, Send, Trash2, X } from "lucide-react";
import type { BranchBatch, BranchBatchStatus, Task } from "../../types";
import s from "../../styles";
import { CreateBranchBatchDialog } from "./CreateBranchBatchDialog";
import { SubmitMrDialog } from "./SubmitMrDialog";

const STATUS_LABEL: Record<BranchBatchStatus, string> = {
  draft: "草稿",
  active: "进行中",
  review: "待评审",
  conflict: "冲突",
  approved: "已通过",
  merged: "已合并",
  rejected: "已拒绝",
  closed: "已关闭",
};

const OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;

function statusStyle(status: BranchBatchStatus) {
  if (status === "active") return s.bbBadgeActive;
  if (status === "conflict") return s.bbBadgeConflict;
  if (status === "approved") return s.bbBadgeDone;
  if (status === "rejected") return s.bbBadgeConflict;
  if (status === "merged") return s.bbBadgeDone;
  return s.bbBadge;
}

export function BranchBatchView({
  projectPath,
  projectId,
  repoPath,
  shellOpen,
  tasks,
  worktreeScope,
  onScopeChange,
  onClose,
}: {
  projectPath: string;
  projectId: string;
  repoPath: string;
  shellOpen: boolean;
  tasks: Task[];
  worktreeScope: string;
  onScopeChange: (path: string) => void;
  onClose: () => void;
}) {
  const [batches, setBatches] = useState<BranchBatch[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [submitBatch, setSubmitBatch] = useState<BranchBatch | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (pid: string) => {
    if (!pid) return;
    try {
      const list = await invoke<BranchBatch[]>("list_branch_batches", { projectId: pid });
      setBatches(list);
    } catch (e) {
      console.error("[branch-batch] load failed:", e);
    }
  }, []);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  // 后台 prepare 完成后没有独立事件：若有批次在准备，轮询刷新状态。
  useEffect(() => {
    const preparing = batches.some((b) => b.prepareStatus === "preparing");
    if (!preparing) return;
    const timer = window.setInterval(() => void load(projectId), 5000);
    return () => window.clearInterval(timer);
  }, [batches, projectId, load]);

  const batchWorktreePath = useCallback((batch: BranchBatch) => {
    return batch.worktreePath ?? `${projectPath}/.nezha/worktrees/${batch.id}`;
  }, [projectPath]);

  /** 仅展示当前选中 worktree 对应的批（一个批最多一条）。 */
  const scopedBatches = useMemo(
    () =>
      batches.filter((b) => {
        if (!worktreeScope) return false;
        return batchWorktreePath(b) === worktreeScope;
      }),
    [batches, worktreeScope, batchWorktreePath],
  );

  const handleOpen = useCallback(
    async (batch: BranchBatch) => {
      setBusyId(batch.id);
      setNotice("");
      try {
        await invoke("open_branch_batch_worktree", { projectPath, projectId, batchId: batch.id });
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectPath, projectId],
  );

  const handleDelete = useCallback(
    async (batch: BranchBatch) => {
      const ok = await confirm(
        `确认删除工作树「${batch.name}」吗？\n将删除本地 worktree 与本地分支，并把批次置为已关闭；远端分支和 MR 不受影响。`,
        { title: "删除 WorkTree", kind: "warning" },
      );
      if (!ok) return;
      setBusyId(batch.id);
      setNotice("");
      try {
        await invoke("delete_branch_batch", { projectPath, projectId, batchId: batch.id, shellOpen });
        onScopeChange("");
        await load(projectId);
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectPath, projectId, load, onScopeChange, shellOpen],
  );

  const handleRetryPrepare = useCallback(
    async (batch: BranchBatch) => {
      setBusyId(batch.id);
      setNotice("");
      try {
        const updated = await invoke<BranchBatch>("retry_branch_batch_prepare", {
          projectPath,
          projectId,
          batchId: batch.id,
        });
        setBatches((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectPath, projectId],
  );

  const canSubmit = (batch: BranchBatch) =>
    batch.status === "active" && (batch.prepareStatus === "ready" || !batch.prepareStatus);

  const prepareBadge = (batch: BranchBatch) => {
    if (batch.prepareStatus === "preparing") {
      return <span style={s.bbBadgeWarn}>准备运行根中</span>;
    }
    if (batch.prepareStatus === "failed") {
      return <span style={s.bbBadgeConflict}>准备失败</span>;
    }
    return null;
  };

  return (
    <div style={s.bbView}>
      <div style={s.bbHeader}>
        <button type="button" style={s.bbBackBtn} onClick={onClose}>
          <X size={14} />
          关闭
        </button>
        <div style={s.bbFill} />
        <button type="button" style={s.bbBtnPrimary} onClick={() => setShowCreate(true)}>
          <Plus size={14} />
          新建 PR
        </button>
      </div>

      {notice && <div style={s.bbError}>{notice}</div>}

      <div style={s.bbList}>
        {scopedBatches.length === 0 && (
          <div style={s.bbEmpty}>当前 worktree 无关联 PR，点击「新建 PR」创建。</div>
        )}
        {scopedBatches.map((batch) => (
          <div key={batch.id} style={s.bbCard}>
            <div style={s.bbCardHead}>
              <span style={s.bbCardTitle}>{batch.name}</span>
              <span style={statusStyle(batch.status)}>{STATUS_LABEL[batch.status]}</span>
              <span style={s.bbBadge}>{batch.kind}</span>
              {prepareBadge(batch)}
              {batch.status !== "merged" &&
                batch.status !== "closed" &&
                Date.now() - batch.createdAt > OVERDUE_MS && (
                  <span style={s.bbBadgeWarn}>超期</span>
                )}
              <div style={s.bbFill} />
              {batch.additions != null && batch.deletions != null && (
                <span style={s.bbMetric}>
                  <span style={s.bbBadgeDone}>+{batch.additions}</span>
                  <span style={s.bbBadgeConflict}>-{batch.deletions}</span>
                </span>
              )}
            </div>
            <div style={s.bbCardSub}>
              <span style={s.bbCardMono}>{batch.branch}</span>
              <span>← {batch.baseBranch}</span>
              <span>→ {batch.targetBranch}</span>
              <span>{batch.taskIds.length} 个议题</span>
              {batch.prepareStatus === "failed" && batch.prepareError && (
                <span style={s.bbCardMono}>{batch.prepareError}</span>
              )}
            </div>
            <div style={s.bbCardActions}>
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={busyId === batch.id}
                onClick={() => void handleOpen(batch)}
              >
                <FolderOpen size={13} />
                打开
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={!canSubmit(batch) || busyId === batch.id}
                onClick={() => setSubmitBatch(batch)}
              >
                <Send size={13} />
                提交 MR
              </button>
              {batch.prepareStatus === "failed" && (
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={busyId === batch.id}
                  onClick={() => void handleRetryPrepare(batch)}
                >
                  <RefreshCw size={13} />
                  重试准备
                </button>
              )}
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={busyId === batch.id}
                onClick={() => void handleDelete(batch)}
              >
                <Trash2 size={13} />
                删除 WorkTree
              </button>
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <CreateBranchBatchDialog
          projectId={projectId}
          projectPath={projectPath}
          repoPath={repoPath}
          tasks={tasks}
          onCreated={(batch) => {
            setBatches((prev) => [...prev, batch]);
            onScopeChange(batchWorktreePath(batch));
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {submitBatch && (
        <SubmitMrDialog
          projectPath={projectPath}
          projectId={projectId}
          batch={submitBatch}
          onDone={() => void load(projectId)}
          onClose={() => setSubmitBatch(null)}
        />
      )}
    </div>
  );
}
