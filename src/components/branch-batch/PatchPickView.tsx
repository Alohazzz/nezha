import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, X } from "lucide-react";
import s from "../../styles";

interface GitCommit {
  hash: string;
  short_hash: string;
  author: string;
  date: string;
  message: string;
  refs: string[];
}

interface PatchPickPlan {
  commit: string;
  already_on_target: boolean;
  needed: string[];
}

interface PatchPickEntry {
  source_commit: string;
  picked_commit: string;
  message: string;
  target_branch: string;
}

interface CherryPickResult {
  picked: string[];
  skipped: string[];
  conflicted: { commit: string; message: string } | null;
}

export function PatchPickView({
  projectPath,
  worktreePath,
  targetBranch,
  onClose,
}: {
  projectPath: string;
  worktreePath: string;
  targetBranch: string;
  onClose: () => void;
}) {
  const [sourceBranch, setSourceBranch] = useState("develop");
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [plans, setPlans] = useState<PatchPickPlan[]>([]);
  const [picks, setPicks] = useState<PatchPickEntry[]>([]);
  const [message, setMessage] = useState("");

  const toggle = (hash: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const reload = useCallback(async () => {
    try {
      const list = await invoke<GitCommit[]>("git_log", {
        projectPath,
        limit: 50,
        search: null,
        branch: sourceBranch,
      });
      setCommits(list);
      const matrix = await invoke<PatchPickEntry[]>("list_patch_picks", {
        projectPath,
        worktreePath,
      });
      setPicks(matrix);
    } catch (e) {
      console.error("[patch-pick] reload failed:", e);
    }
  }, [projectPath, worktreePath, sourceBranch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const check = useCallback(async () => {
    if (selected.size === 0) return;
    try {
      const plan = await invoke<PatchPickPlan[]>("git_patch_dependency_check", {
        projectPath,
        worktreePath,
        commitHashes: Array.from(selected),
      });
      setPlans(plan);
    } catch (e) {
      console.error("[patch-pick] check failed:", e);
    }
  }, [projectPath, worktreePath, selected]);

  const pick = useCallback(async () => {
    if (selected.size === 0) return;
    setMessage("");
    try {
      const result = await invoke<CherryPickResult>("cherry_pick_to_patch", {
        projectPath,
        worktreePath,
        commitHashes: Array.from(selected),
      });
      if (result.conflicted) {
        setMessage(`冲突：${result.conflicted.commit} — ${result.conflicted.message}`);
      } else {
        setMessage(`已挑拣 ${result.picked.length} 条，跳过 ${result.skipped.length} 条（已在目标）`);
        await reload();
      }
    } catch (e) {
      setMessage(String(e));
    }
  }, [projectPath, worktreePath, selected, reload]);

  return (
    <div style={s.bbDiffOverlay}>
      <div style={s.bbDiffDialog}>
        <div style={s.bbDiffHead}>
          <span style={s.bbCardMono}>{targetBranch}</span>
          <span>· 挑拣容器（仅挑拣，禁开发/向上合并）</span>
          <div style={s.bbFill} />
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            关闭
          </button>
        </div>

        <div style={s.bbToolbar}>
          <span style={s.bbFieldLabel}>来源分支</span>
          <input
            style={s.bbSourceInput}
            value={sourceBranch}
            onChange={(e) => setSourceBranch(e.target.value)}
          />
          <button type="button" style={s.bbBtnGhost} onClick={() => void reload()}>
            <RefreshCw size={13} />
            刷新
          </button>
        </div>

        <div style={s.bbDiffBody}>
          <div style={s.bbDiffFiles}>
            <div style={s.bbFieldLabel}>来源 commit（勾选后点「依赖预检」）</div>
            {commits.map((c) => (
              <label key={c.hash} style={s.bbMember}>
                <input type="checkbox" checked={selected.has(c.hash)} onChange={() => toggle(c.hash)} />
                <span style={s.bbCardMono}>{c.short_hash}</span>
                <span>{c.message}</span>
              </label>
            ))}
          </div>

          <div style={s.bbDiffPane}>
            <div style={s.bbFieldLabel}>依赖预检</div>
            {plans.map((p) => (
              <div key={p.commit} style={s.bbCardSub}>
                <span style={s.bbCardMono}>{p.commit.slice(0, 7)}</span>
                {p.already_on_target ? (
                  <span style={s.bbBadgeDone}>已在目标</span>
                ) : (
                  <span>
                    需连带挑 {p.needed.length} 条（依赖序）：
                    <span style={s.bbCardMono}>{p.needed.slice(0, 3).map((n) => n.slice(0, 7)).join(", ")}…</span>
                  </span>
                )}
              </div>
            ))}
            {picks.length > 0 && (
              <>
                <div style={s.bbSection}>
                  <span style={s.bbFieldLabel}>版本矩阵（已挑）</span>
                </div>
                {picks.map((p) => (
                  <div key={p.picked_commit} style={s.bbCardSub}>
                    <span style={s.bbCardMono}>{p.picked_commit.slice(0, 7)}</span>
                    <span>← 来自 {p.source_commit.slice(0, 7)}</span>
                    <span style={s.bbCardMono}>{p.target_branch}</span>
                  </div>
                ))}
              </>
            )}
            {message && <div style={s.bbError}>{message}</div>}
            <div style={s.bbCardActions}>
              <button type="button" style={s.bbBtnGhost} onClick={() => void check()}>
                依赖预检
              </button>
              <button type="button" style={s.bbBtnPrimary} onClick={() => void pick()}>
                按依赖序挑拣（{selected.size} 条）
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
