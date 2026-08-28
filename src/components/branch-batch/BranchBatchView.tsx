import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import type { BranchBatch, BranchBatchStatus, Project, Task } from "../../types";
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
  projects,
  tasks,
  onBack,
}: {
  projects: Project[];
  tasks: Task[];
  onBack: () => void;
}) {
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? "");
  const [batches, setBatches] = useState<BranchBatch[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [diffBatch, setDiffBatch] = useState<BranchBatch | null>(null);
  const [pickBatch, setPickBatch] = useState<BranchBatch | null>(null);
  const [reviewBatch, setReviewBatch] = useState<BranchBatch | null>(null);
  const [reviewPassed, setReviewPassed] = useState<Set<string>>(() => new Set());
  const [conflictBatch, setConflictBatch] = useState<BranchBatch | null>(null);

  const selectedProject = useMemo(() => projects.find((p) => p.id === projectId), [projects, projectId]);

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
      if (!selectedProject) return;
      try {
        await invoke("close_branch_batch", {
          projectId: selectedProject.id,
          batchId: batch.id,
          merged,
        });
        await load(selectedProject.id);
      } catch (e) {
        console.error("[branch-batch] close failed:", e);
      }
    },
    [selectedProject, load],
  );

  const merge = useCallback(
    async (batch: BranchBatch) => {
      if (!selectedProject) return;
      try {
        await invoke<{ message: string; batch: BranchBatch }>("merge_branch_batch", {
          projectPath: selectedProject.path,
          projectId: selectedProject.id,
          batchId: batch.id,
        });
        await load(selectedProject.id);
      } catch (e) {
        console.error("[branch-batch] merge failed:", e);
      }
    },
    [selectedProject, load],
  );

  return (
    <div style={s.bbView}>
      <div style={s.bbHeader}>
        <button type="button" style={s.bbBackBtn} onClick={onBack}>
          <ArrowLeft size={14} />
          返回
        </button>
        <span style={s.bbTitle}>分支批</span>
        <div style={s.bbOptionGrid}>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              style={projectId === p.id ? s.bbOptionBtnActive : s.bbOptionBtn}
              onClick={() => setProjectId(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        <div style={s.bbFill} />
        <button type="button" style={s.bbBtnPrimary} onClick={() => setShowCreate(true)}>
          <Plus size={14} />
          新建批
        </button>
      </div>

      <div style={s.bbList}>
        {batches.length === 0 && <div style={s.bbEmpty}>暂无分支批，点击「新建批」创建。</div>}
        {batches.map((batch) => (
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
            <div style={s.bbCardActions}>
              <button type="button" style={s.bbBtnGhost} onClick={() => setDiffBatch(batch)}>
                <RefreshCw size={13} />
                查看 Diff
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
              <button
                type="button"
                style={s.bbBtnGhost}
                onClick={() => void close(batch, false)}
              >
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

      {showCreate && selectedProject && (
        <CreateBranchBatchDialog
          projectId={selectedProject.id}
          projectPath={selectedProject.path}
          tasks={tasks}
          onCreated={(batch) => setBatches((prev) => [...prev, batch])}
          onClose={() => setShowCreate(false)}
        />
      )}

      {diffBatch && selectedProject && (
        <BranchBatchDiff
          projectPath={selectedProject.path}
          baseBranch={diffBatch.baseBranch}
          branch={diffBatch.branch}
          onClose={() => setDiffBatch(null)}
        />
      )}

      {pickBatch && selectedProject && (
        <PatchPickView
          projectPath={selectedProject.path}
          worktreePath={`${selectedProject.path}/.nezha/worktrees/${pickBatch.id}`}
          targetBranch={pickBatch.branch}
          onClose={() => setPickBatch(null)}
        />
      )}

      {reviewBatch && selectedProject && (
        <MergeReviewView
          projectPath={selectedProject.path}
          worktreePath={`${selectedProject.path}/.nezha/worktrees/${reviewBatch.id}`}
          baseBranch={reviewBatch.baseBranch}
          branch={reviewBatch.branch}
          agent="claude"
          onPass={() =>
            setReviewPassed((prev) => new Set(prev).add(reviewBatch.id))
          }
          onClose={() => setReviewBatch(null)}
        />
      )}

      {conflictBatch && selectedProject && (
        <ConflictResolveView
          projectPath={selectedProject.path}
          worktreePath={`${selectedProject.path}/.nezha/worktrees/${conflictBatch.id}`}
          onClose={() => setConflictBatch(null)}
        />
      )}
    </div>
  );
}
