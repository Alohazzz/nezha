import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appConfirm } from "../AppConfirmDialog";
import { FolderOpen, Plus, Send, Trash2, X } from "lucide-react";
import type { DeliveryPlan, DeliveryPlanStatus, Task } from "../../types";
import { rpRootStyle } from "../../styles/right-panel";
import { CreatePlanDialog } from "./CreatePlanDialog";
import { SubmitMrDialog } from "./SubmitMrDialog";
import { batchScopeKey } from "./worktreeScope";

const STATUS_LABEL: Record<DeliveryPlanStatus, string> = {
  active: "进行中",
  review: "待评审",
  merged: "已合并",
  closed: "已关闭",
};

const OVERDUE_MS = 14 * 24 * 60 * 60 * 1000;

/** 状态 → 徽标色调（pr-badge data-tone），与右侧面板设计语言的语义色一致。 */
function statusTone(status: DeliveryPlanStatus): string | undefined {
  if (status === "active") return "active";
  if (status === "merged" || status === "closed") return "done";
  return undefined;
}

export function DeliveryPlanView({
  projectPath,
  projectId,
  repoPath,
  shellOpen,
  tasks,
  worktreeScope,
  onScopeChange,
  onClose,
  width = 280,
}: {
  projectPath: string;
  projectId: string;
  repoPath: string;
  shellOpen: boolean;
  tasks: Task[];
  worktreeScope: string;
  onScopeChange: (path: string) => void;
  onClose: () => void;
  width?: number;
}) {
  const [batches, setBatches] = useState<DeliveryPlan[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [submitBatch, setSubmitBatch] = useState<DeliveryPlan | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async (pid: string) => {
    if (!pid) return [];
    try {
      const list = await invoke<DeliveryPlan[]>("list_delivery_plans", {
        projectId: pid,
        projectPath,
      });
      setBatches(list);
      return list;
    } catch (e) {
      console.error("[branch-batch] load failed:", e);
      return [];
    }
  }, [projectPath]);

  useEffect(() => {
    void load(projectId);
  }, [projectId, load]);

  /** 仅展示当前选中作用域对应的批（无 worktree 的批归主检出）。 */
  const scopedBatches = useMemo(
    () =>
      batches.filter((b) => {
        if (b.worktreeMissing) return false;
        return batchScopeKey(b, projectPath) === worktreeScope;
      }),
    [batches, worktreeScope, projectPath],
  );

  /** 失效批次不出现在 selector，但仍保留清理入口，避免记录变成不可达的孤儿数据。 */
  const missingBatches = useMemo(
    () => batches.filter((b) => b.worktreeMissing),
    [batches],
  );

  const handleOpen = useCallback(
    async (batch: DeliveryPlan) => {
      setBusyId(batch.id);
      setNotice("");
      try {
        await invoke("open_delivery_plan_worktree", { projectPath, projectId, batchId: batch.id });
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectPath, projectId],
  );

  const handleDelete = useCallback(
    async (batch: DeliveryPlan) => {
      const inMainCheckout = batch.useWorktree === false;
      const ok = await appConfirm(
        inMainCheckout
          ? `确认删除 PR「${batch.name}」吗？\n将删除本地分支；仅当远端分支也已不存在时才会移除本条 PR 记录，否则只做关闭留痕。`
          : `确认删除工作树「${batch.name}」吗？\n将删除本地 worktree 与本地分支，并把批次置为已关闭；远端分支和 MR 不受影响。`,
        { title: inMainCheckout ? "删除 PR" : "删除 WorkTree", kind: "warning" },
      );
      if (!ok) return;
      setBusyId(batch.id);
      setNotice("");
      try {
        await invoke("delete_delivery_plan", { projectPath, projectId, batchId: batch.id, shellOpen });
        onScopeChange("");
        const list = await load(projectId);
        // 远端分支仍存在时后端只关批不移除记录，明示这个结果避免「删了没反应」的困惑。
        if (inMainCheckout && list.some((b) => b.id === batch.id)) {
          setNotice("远端分支仍存在，已关闭该 PR 记录；需彻底删除请先在代码平台删除远端分支。");
        }
      } catch (e) {
        setNotice(String(e));
      } finally {
        setBusyId(null);
      }
    },
    [projectPath, projectId, load, onScopeChange, shellOpen],
  );

  const canSubmit = (batch: DeliveryPlan) => batch.status === "active";

  const renderBatchCard = (batch: DeliveryPlan, missing = false) => {
    // 无 worktree 的批分支就在主检出里，只有「打开」的落点不同。
    const inMainCheckout = batch.useWorktree === false;
    return (
    <div key={batch.id} className="pr-card">
      <div className="pr-card-head">
        <span className="pr-card-title">{batch.name}</span>
        <span className="pr-badge" data-tone={statusTone(batch.status)}>
          {STATUS_LABEL[batch.status]}
        </span>
        <span className="pr-badge">{batch.kind}</span>
        {inMainCheckout && <span className="pr-badge">主检出</span>}
        {missing && <span className="pr-badge" data-tone="warn">WorkTree 缺失</span>}
        {batch.runRootMissing && <span className="pr-badge" data-tone="warn">运行程序缺失</span>}
        {batch.status !== "merged" &&
          batch.status !== "closed" &&
          Date.now() - batch.createdAt > OVERDUE_MS && (
            <span className="pr-badge" data-tone="warn">超期</span>
          )}
      </div>
      <div className="pr-card-sub">
        <span className="pr-card-mono">{batch.branch}</span>
        <span>← {batch.baseBranch}</span>
        <span>→ {batch.targetBranch || "（未指定合并目标）"}</span>
        <span>{batch.issues.length} 个议题</span>
      </div>
      <div className="pr-card-actions">
        <button
          type="button"
          className="rp-btn"
          disabled={missing || busyId === batch.id}
          onClick={() => void handleOpen(batch)}
          title={inMainCheckout ? "打开仓库主工作区" : undefined}
        >
          <FolderOpen size={13} />
          打开
        </button>
        <button
          type="button"
          className="rp-btn"
          data-variant="primary"
          disabled={!canSubmit(batch) || missing || busyId === batch.id}
          onClick={() => setSubmitBatch(batch)}
        >
          <Send size={13} />
          提交 MR
        </button>
        <button
          type="button"
          className="rp-btn"
          disabled={busyId === batch.id}
          onClick={() => void handleDelete(batch)}
        >
          <Trash2 size={13} />
          {inMainCheckout ? "删除 PR" : "删除 WorkTree"}
        </button>
      </div>
    </div>
    );
  };

  return (
    <div className="rp-root" style={rpRootStyle(width)}>
      <div className="rp-header">
        <div className="rp-titlebar">
          <span className="rp-title">PR</span>
          <button
            type="button"
            className="rp-text-btn"
            data-variant="primary"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={11} />
            新建 PR
          </button>
          <button type="button" className="rp-icon-btn" onClick={onClose} title="关闭">
            <X size={13} />
          </button>
        </div>
      </div>

      {notice && <div className="rp-error">{notice}</div>}

      <div className="pr-body">
        {scopedBatches.length === 0 && (
          <div className="rp-empty">
            {worktreeScope
              ? "当前 worktree 无关联 PR，点击「新建 PR」创建。"
              : "主检出下暂无关联 PR，点击「新建 PR」创建。"}
          </div>
        )}
        {scopedBatches.map((batch) => renderBatchCard(batch))}

        {missingBatches.length > 0 && (
          <>
            <div className="pr-notice">
              以下批次记录仍保留，但 worktree 目录已不存在；可确认分支不需要后清理。
            </div>
            {missingBatches.map((batch) => renderBatchCard(batch, true))}
          </>
        )}
      </div>

      {showCreate && (
        <CreatePlanDialog
          projectId={projectId}
          projectPath={projectPath}
          repoPath={repoPath}
          tasks={tasks}
          onCreated={(batch) => {
            setBatches((prev) => [...prev, batch]);
            onScopeChange(batchScopeKey(batch, projectPath));
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
