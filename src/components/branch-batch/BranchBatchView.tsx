import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Plus, RefreshCw, X } from "lucide-react";
import type { BranchBatch, BranchBatchStatus, Task } from "../../types";
import s from "../../styles";
import { CreateBranchBatchDialog } from "./CreateBranchBatchDialog";
import { BranchBatchDiff } from "./BranchBatchDiff";
import { PatchPickView } from "./PatchPickView";
import { MergeReviewView } from "./MergeReviewView";
import { ConflictResolveView } from "./ConflictResolveView";

const STATUS_LABEL: Record<BranchBatchStatus, string> = {
  draft: "草稿",
  active: "进行中",
  review: "待评审",
  conflict: "冲突",
  merged: "已合并",
  closed: "已关闭",
};

const OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;

function statusStyle(status: BranchBatchStatus) {
  if (status === "active") return s.bbBadgeActive;
  if (status === "conflict") return s.bbBadgeConflict;
  if (status === "merged") return s.bbBadgeDone;
  return s.bbBadge;
}

export function BranchBatchView({
  projectPath,
  projectId,
  tasks,
  worktreeScope,
  onScopeChange,
  onClose,
}: {
  projectPath: string;
  projectId: string;
  tasks: Task[];
  worktreeScope: string;
  onScopeChange: (path: string) => void;
  onClose: () => void;
}) {
  const [batches, setBatches] = useState<BranchBatch[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [diffBatch, setDiffBatch] = useState<BranchBatch | null>(null);
  const [pickBatch, setPickBatch] = useState<BranchBatch | null>(null);
  const [reviewBatch, setReviewBatch] = useState<BranchBatch | null>(null);
  const [reviewPassed, setReviewPassed] = useState<Set<string>>(() => new Set());
  const [conflictBatch, setConflictBatch] = useState<BranchBatch | null>(null);

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

  const close = useCallback(
    async (batch: BranchBatch, merged: boolean) => {
      try {
        await invoke("close_branch_batch", { projectId, batchId: batch.id, merged });
        await load(projectId);
      } catch (e) {
        console.error("[branch-batch] close failed:", e);
      }
    },
    [projectId, load],
  );

  const merge = useCallback(
    async (batch: BranchBatch) => {
      try {
        await invoke<{ message: string; batch: BranchBatch }>("merge_branch_batch", {
          projectPath,
          projectId,
          batchId: batch.id,
        });
        await load(projectId);
      } catch (e) {
        console.error("[branch-batch] merge failed:", e);
      }
    },
    [projectPath, projectId, load],
  );

  /** 仅展示当前选中 worktree 对应的批（一个批最多一条）。 */
  const scopedBatches = useMemo(
    () =>
      batches.filter((b) => {
        if (!worktreeScope) return false;
        return `${projectPath}/.nezha/worktrees/${b.id}` === worktreeScope;
      }),
    [batches, worktreeScope, projectPath],
  );

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
            </div>
            <div style={s.bbCardSub}>
              <span style={s.bbCardMono}>worktree: {projectPath}/.nezha/worktrees/{batch.id}</span>
            </div>
            <div style={s.bbCardActions}>
              <button type="button" style={s.bbBtnGhost} onClick={() => setDiffBatch(batch)}>
                <RefreshCw size={13} />
                查看 Diff
              </button>
              <button
                type="button"
                style={s.bbBtnGhost}
                onClick={() =>
                  void navigator.clipboard.writeText(`${projectPath}/.nezha/worktrees/${batch.id}`)
                }
              >
                复制路径
              </button>
              <button
                type="button"
                style={s.bbBtnGhost}
                disabled={batch.status === "merged" || batch.status === "closed"}
                onClick={() =>
                  void invoke("open_in_system_file_manager", {
                    path: `${projectPath}/.nezha/worktrees/${batch.id}`,
                    projectPath,
                  })
                }
              >
                打开
              </button>
              {batch.status === "active" && (
                <button type="button" style={s.bbBtnGhost} onClick={() => setReviewBatch(batch)}>
                  审查
                </button>
              )}
              {batch.kind === "hotfix" && (
                <button type="button" style={s.bbBtnGhost} onClick={() => setPickBatch(batch)}>
                  挑拣
                </button>
              )}
              {batch.kind === "hotfix" && (
                <button type="button" style={s.bbBtnGhost} onClick={() => setConflictBatch(batch)}>
                  解决冲突
                </button>
              )}
              <button type="button" style={s.bbBtnGhost} onClick={() => void close(batch, false)}>
                关闭
              </button>
              {batch.status === "active" && (
                <button
                  type="button"
                  style={s.bbBtnPrimary}
                  disabled={!reviewPassed.has(batch.id)}
                  onClick={() => void merge(batch)}
                >
                  合并到 {batch.targetBranch}
                </button>
              )}
              {batch.status === "active" && !reviewPassed.has(batch.id) && (
                <span style={s.bbGateHint}>需先通过代码审查</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <CreateBranchBatchDialog
          projectId={projectId}
          projectPath={projectPath}
          tasks={tasks}
          onCreated={(batch) => {
            setBatches((prev) => [...prev, batch]);
            onScopeChange(`${projectPath}/.nezha/worktrees/${batch.id}`);
          }}
          onClose={() => setShowCreate(false)}
        />
      )}

      {diffBatch && (
        <BranchBatchDiff
          projectPath={projectPath}
          baseBranch={diffBatch.baseBranch}
          branch={diffBatch.branch}
          onClose={() => setDiffBatch(null)}
        />
      )}

      {pickBatch && (
        <PatchPickView
          projectPath={projectPath}
          worktreePath={`${projectPath}/.nezha/worktrees/${pickBatch.id}`}
          targetBranch={pickBatch.branch}
          onClose={() => setPickBatch(null)}
        />
      )}

      {reviewBatch && (
        <MergeReviewView
          projectPath={projectPath}
          worktreePath={`${projectPath}/.nezha/worktrees/${reviewBatch.id}`}
          baseBranch={reviewBatch.baseBranch}
          branch={reviewBatch.branch}
          agent="claude"
          onPass={() => setReviewPassed((prev) => new Set(prev).add(reviewBatch.id))}
          onClose={() => setReviewBatch(null)}
        />
      )}

      {conflictBatch && (
        <ConflictResolveView
          projectPath={projectPath}
          worktreePath={`${projectPath}/.nezha/worktrees/${conflictBatch.id}`}
          onClose={() => setConflictBatch(null)}
        />
      )}
    </div>
  );
}
