import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BranchBatch, BranchKind, Task } from "../../types";
import s from "../../styles";

const KINDS: Array<{ key: BranchKind; label: string }> = [
  { key: "feature", label: "feature · 日常开发" },
  { key: "patch", label: "patch · 现场响应" },
  { key: "release", label: "release · 上线验收" },
  { key: "hotfix", label: "hotfix · 补丁" },
];

export function CreateBranchBatchDialog({
  projectId,
  projectPath,
  tasks,
  onCreated,
  onClose,
}: {
  projectId: string;
  projectPath: string;
  tasks: Task[];
  onCreated: (batch: BranchBatch) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BranchKind>("feature");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [targetBranch, setTargetBranch] = useState("develop");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    if (!name.trim() || !baseBranch.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const batch = await invoke<BranchBatch>("create_branch_batch", {
        projectPath,
        projectId,
        id: crypto.randomUUID(),
        name: name.trim(),
        kind,
        baseBranch: baseBranch.trim(),
        targetBranch: targetBranch.trim() || baseBranch.trim(),
        taskIds: Array.from(selected),
      });
      onCreated(batch);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.bbDialog}>
        <div style={s.bbDialogTitle}>创建分支批（PR 前置创建）</div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>批名称</span>
          <input
            style={s.bbInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：门诊挂号优化"
          />
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>类型</span>
          <div style={s.bbOptionGrid}>
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                style={kind === k.key ? s.bbOptionBtnActive : s.bbOptionBtn}
                onClick={() => setKind(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>基础分支</span>
          <input
            style={s.bbInput}
            value={baseBranch}
            onChange={(e) => setBaseBranch(e.target.value)}
            placeholder="develop"
          />
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>合并回目标分支</span>
          <input
            style={s.bbInput}
            value={targetBranch}
            onChange={(e) => setTargetBranch(e.target.value)}
            placeholder="develop"
          />
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>选择议题（构成一个可验收批次，顺序即任务顺序）</span>
          <div style={s.bbMemberList}>
            {projectTasks.length === 0 && <div style={s.bbMember}>暂无可选任务</div>}
            {projectTasks.map((task) => (
              <label key={task.id} style={s.bbMember}>
                <input type="checkbox" checked={selected.has(task.id)} onChange={() => toggle(task.id)} />
                <span style={s.bbCardMono}>{task.name || task.prompt.slice(0, 24)}</span>
              </label>
            ))}
          </div>
        </div>

        {error && (
          <div style={s.bbError}>{error}</div>
        )}

        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            取消
          </button>
          <button type="button" style={s.bbBtnPrimary} onClick={submit} disabled={busy}>
            {busy ? "创建中…" : "创建批 + 分支 + worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
