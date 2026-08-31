import { useCallback, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import type { BranchBatch, BranchConflictCheck, BranchKind, Task } from "../../types";
import s from "../../styles";

const KINDS: Array<{ key: BranchKind; label: string }> = [
  { key: "feature", label: "feature · 日常开发" },
  { key: "patch", label: "patch · 现场响应" },
  { key: "release", label: "release · 上线验收" },
  { key: "hotfix", label: "hotfix · 补丁" },
];

function branchNameFor(kind: BranchKind, name: string): string {
  const prefix = kind === "patch" ? "patch" : kind === "release" ? "release" : kind === "hotfix" ? "hotfix" : "feature";
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return `${prefix}/${slug || "batch"}`;
}

export function CreateBranchBatchDialog({
  projectId,
  projectPath,
  repoPath,
  tasks,
  onCreated,
  onClose,
}: {
  projectId: string;
  projectPath: string;
  repoPath: string;
  tasks: Task[];
  onCreated: (batch: BranchBatch) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<BranchKind>("feature");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [targetBranch, setTargetBranch] = useState("develop");
  const [sourceBranch, setSourceBranch] = useState("feature/batch");
  const [useExistingRemote, setUseExistingRemote] = useState(false);
  const [remoteConflict, setRemoteConflict] = useState(false);
  const [localConflict, setLocalConflict] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const manualBranchRef = useRef(false);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );

  const updateGeneratedBranch = useCallback((k: BranchKind, n: string) => {
    if (manualBranchRef.current) return;
    setSourceBranch(branchNameFor(k, n));
    setUseExistingRemote(false);
    setRemoteConflict(false);
    setLocalConflict(false);
  }, []);

  const handleNameChange = (value: string) => {
    setName(value);
    updateGeneratedBranch(kind, value);
  };

  const handleKindChange = (value: BranchKind) => {
    setKind(value);
    updateGeneratedBranch(value, name);
  };

  const handleBranchEdit = (value: string) => {
    manualBranchRef.current = true;
    setSourceBranch(value);
    setUseExistingRemote(false);
    setRemoteConflict(false);
    setLocalConflict(false);
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const checkRemote = useCallback(async () => {
    if (!sourceBranch.trim() || checking) return;
    setChecking(true);
    setError("");
    try {
      const check = await invoke<BranchConflictCheck>("check_branch_batch_branch", {
        projectPath,
        repoPath,
        branch: sourceBranch.trim(),
      });
      setRemoteConflict(check.remoteExists);
      setLocalConflict(check.localExists);
      if (check.localExists) {
        setError("本地已存在同名分支，请改名。");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [sourceBranch, checking, projectPath, repoPath]);

  const chooseContinue = () => {
    setUseExistingRemote(true);
    setRemoteConflict(false);
  };

  const chooseRename = () => {
    setUseExistingRemote(false);
    setRemoteConflict(false);
    manualBranchRef.current = true;
    setSourceBranch((prev) => `${prev}-new`);
  };

  const submit = async () => {
    if (!name.trim() || !baseBranch.trim() || !targetBranch.trim() || !sourceBranch.trim() || busy) return;
    if (localConflict) {
      setError("请先处理本地同名分支后再创建。");
      return;
    }
    if (remoteConflict && !useExistingRemote) {
      setError("请选择「继续使用远端分支」或改名。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const batch = await invoke<BranchBatch>("create_branch_batch", {
        projectPath,
        repoPath,
        projectId,
        id: crypto.randomUUID(),
        name: name.trim(),
        kind,
        baseBranch: baseBranch.trim(),
        targetBranch: targetBranch.trim() || baseBranch.trim(),
        taskIds: Array.from(selected),
        sourceBranch: sourceBranch.trim(),
        useExistingRemote,
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
        <div style={s.bbDialogTitle}>创建 PR</div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>批名称</span>
          <input
            style={s.bbInput}
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
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
                onClick={() => handleKindChange(k.key)}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>源分支</span>
          <div style={s.bbSourceRow}>
            <input
              style={s.bbInput}
              value={sourceBranch}
              onChange={(e) => handleBranchEdit(e.target.value)}
              onBlur={() => void checkRemote()}
              spellCheck={false}
            />
            <button type="button" style={s.bbBtnGhost} disabled={checking} onClick={() => void checkRemote()}>
              <RefreshCw size={13} />
              检测
            </button>
          </div>
        </div>

        {remoteConflict && (
          <div style={s.bbError}>
            <AlertTriangle size={12} />
            远端存在同名分支
            <div style={s.bbConflictActions}>
              <button type="button" style={s.bbBtnPrimary} onClick={chooseContinue}>
                继续使用远端分支
              </button>
              <button type="button" style={s.bbBtnGhost} onClick={chooseRename}>
                改名
              </button>
            </div>
          </div>
        )}

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

        {error && <div style={s.bbError}>{error}</div>}

        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            取消
          </button>
          <button type="button" style={s.bbBtnPrimary} onClick={submit} disabled={busy || checking}>
            {busy ? "创建中…" : "创建批 + 分支 + worktree"}
          </button>
        </div>
      </div>
    </div>
  );
}
