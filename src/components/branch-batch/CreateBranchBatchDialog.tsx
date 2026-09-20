import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ChevronDown, Check, FolderOpen, RefreshCw, X } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import type {
  AppSettings,
  YunxiaoSettings,
} from "../app-settings/types";
import { EMPTY_YUNXIAO_SETTINGS } from "../app-settings/types";
import type {
  BranchBatch,
  BranchConflictCheck,
  BranchKind,
  Task,
  YunxiaoVersion,
} from "../../types";
import s from "../../styles";

const KINDS: Array<{ key: BranchKind; label: string }> = [
  { key: "feature", label: "feature · 日常开发" },
  { key: "fix", label: "fix · 缺陷修复" },
  { key: "patch", label: "patch · 现场响应" },
  { key: "project", label: "project · 上线验收" },
  { key: "hotfix", label: "hotfix · 补丁" },
];

/** 云效版本名（`v2.20260901.0`）→ 分支里的版本段（`v2.20260901`）：去掉尾部 `.0`。 */
export function normalizeVersionSegment(name: string): string {
  return name.trim().replace(/\.0$/, "");
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
  const [worktreeDir, setWorktreeDir] = useState("");
  const [kind, setKind] = useState<BranchKind>("feature");
  const [baseBranch, setBaseBranch] = useState("develop");
  const [targetBranch, setTargetBranch] = useState("develop");
  const [version, setVersion] = useState("");
  const [versionPickerOpen, setVersionPickerOpen] = useState(false);
  const [useWorktree, setUseWorktree] = useState(false);
  const [sourceBranch, setSourceBranch] = useState("");
  const [useExistingRemote, setUseExistingRemote] = useState(false);
  const [remoteConflict, setRemoteConflict] = useState(false);
  const [localConflict, setLocalConflict] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const manualBranchRef = useRef(false);

  // 云效版本选项（取不到就退回手输，不阻断创建）。
  const [yunxiao, setYunxiao] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [versions, setVersions] = useState<YunxiaoVersion[]>([]);

  useEffect(() => {
    let cancelled = false;
    invoke<AppSettings>("load_app_settings")
      .then((settings) => {
        if (!cancelled) setYunxiao(settings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const { token, organizationId, projectId: yunxiaoProjectId } = yunxiao;
    if (!token || !organizationId || !yunxiaoProjectId) return;
    let cancelled = false;
    invoke<YunxiaoVersion[]>("yunxiao_list_versions", {
      token,
      organizationId,
      projectId: yunxiaoProjectId,
    })
      .then((list) => {
        if (!cancelled) setVersions(Array.isArray(list) ? list : []);
      })
      .catch((e) => console.warn("[create-batch] load versions failed:", e));
    return () => {
      cancelled = true;
    };
  }, [yunxiao]);

  // 默认代码目录 = 项目配置基路径 / 共享 hub / 项目内默认，创建者可改。
  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_branch_batch_worktree_base", { projectPath, repoPath })
      .then((dir) => {
        if (!cancelled) setWorktreeDir(dir);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath, repoPath]);

  // 源分支名由后端统一生成（与 create_branch_batch 同源），前端只做展示。
  // 用户手动改过之后不再自动覆盖。
  useEffect(() => {
    if (manualBranchRef.current) return;
    let cancelled = false;
    invoke<string>("preview_branch_batch_branch", {
      kind,
      version: version.trim() || null,
      targetBranch: targetBranch.trim() || null,
      name: name.trim(),
    })
      .then((branch) => {
        if (!cancelled && !manualBranchRef.current) setSourceBranch(branch);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [kind, version, targetBranch, name]);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );

  const versionOptions = useMemo(
    () =>
      versions
        .map((v) => normalizeVersionSegment(v.name))
        .filter((v) => v.length > 0)
        .filter((v, i, all) => all.indexOf(v) === i),
    [versions],
  );

  const handleBranchEdit = (value: string) => {
    manualBranchRef.current = true;
    setSourceBranch(value);
    setUseExistingRemote(false);
    setRemoteConflict(false);
    setLocalConflict(false);
  };

  const handleNameChange = (value: string) => {
    // 改批名即恢复自动生成：源分支跟着批名走（与手改后不覆盖的规则一致）。
    manualBranchRef.current = false;
    setName(value);
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
    if (
      !name.trim() ||
      !baseBranch.trim() ||
      !targetBranch.trim() ||
      !sourceBranch.trim() ||
      (useWorktree && !worktreeDir.trim()) ||
      busy
    )
      return;
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
        worktreeDir: useWorktree ? worktreeDir.trim() : null,
        version: version.trim() || null,
        useWorktree,
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
            placeholder="如：锁号地址挂号异常问题"
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
          <span style={s.bbFieldLabel}>版本（取自云效，可手输）</span>
          <div style={s.bbSourceRow}>
            <input
              style={s.bbSourceInput}
              value={version}
              onChange={(e) => {
                manualBranchRef.current = false;
                setVersion(e.target.value);
              }}
              placeholder="如 v2.20260901；留空则不生成版本段"
              spellCheck={false}
            />
            <Popover.Root open={versionPickerOpen} onOpenChange={setVersionPickerOpen}>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  style={s.bbBtnGhost}
                  disabled={versionOptions.length === 0}
                  title={versionOptions.length === 0 ? "未取到云效版本，可手动输入" : undefined}
                >
                  <ChevronDown size={13} />
                  选择
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="branch-popover-content"
                  sideOffset={4}
                  align="start"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  <div className="branch-popover-list">
                    <button
                      type="button"
                      className="branch-popover-item"
                      onClick={() => {
                        manualBranchRef.current = false;
                        setVersion("");
                        setVersionPickerOpen(false);
                      }}
                    >
                      <span className="branch-popover-item-name">不指定版本</span>
                    </button>
                    {versionOptions.map((v) => (
                      <button
                        type="button"
                        key={v}
                        className="branch-popover-item"
                        onClick={() => {
                          manualBranchRef.current = false;
                          setVersion(v);
                          setVersionPickerOpen(false);
                        }}
                      >
                        <span className="branch-popover-item-name">{v}</span>
                        {version === v && (
                          <Check size={12} strokeWidth={2.5} color="var(--accent)" style={s.repoSelectorCheck} />
                        )}
                      </button>
                    ))}
                  </div>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
        </div>

        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>源分支（自动生成，可手改）</span>
          <div style={s.bbSourceRow}>
            <input
              style={s.bbSourceInput}
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

        <label style={s.bbCheckRow}>
          <input
            type="checkbox"
            checked={useWorktree}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          另建 worktree（并行隔离用）
          <span style={s.bbCheckHint}>
            {useWorktree ? "批分支落在独立代码目录" : "批分支直接切在主工作区"}
          </span>
        </label>

        {useWorktree && (
          <div style={s.bbField}>
            <span style={s.bbFieldLabel}>代码目录（worktree 创建位置，运行程序不自动复制）</span>
            <div style={s.bbSourceRow}>
              <input
                style={s.bbInput}
                value={worktreeDir}
                onChange={(e) => setWorktreeDir(e.target.value)}
                placeholder="如 H:\Project\Company\worktree"
                spellCheck={false}
              />
              <button
                type="button"
                style={s.bbBtnGhost}
                onClick={async () => {
                  const selected = await openDialog({ directory: true, multiple: false });
                  if (selected) setWorktreeDir(selected);
                }}
              >
                <FolderOpen size={13} />
                选择
              </button>
            </div>
          </div>
        )}

        {error && <div style={s.bbError}>{error}</div>}

        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            取消
          </button>
          <button
            type="button"
            style={s.bbBtnPrimary}
            onClick={submit}
            disabled={busy || checking}
          >
            {busy
              ? "创建中…"
              : useWorktree
                ? "创建批 + 分支 + worktree"
                : "创建批 + 分支"}
          </button>
        </div>
      </div>
    </div>
  );
}
