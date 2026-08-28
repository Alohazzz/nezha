import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import s from "../../styles";

interface ConflictContext {
  conflicted_files: string[];
  prompt: string;
}

export function ConflictResolveView({
  projectPath,
  worktreePath,
  agent = "claude",
  onClose,
}: {
  projectPath: string;
  worktreePath: string;
  agent?: string;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<ConflictContext | null>(null);
  const [running, setRunning] = useState(false);
  const [resolved, setResolved] = useState("");
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    void invoke<ConflictContext>("get_conflict_context", { projectPath, worktreePath })
      .then(setCtx)
      .catch((e) => console.error("[conflict] load context failed:", e));
  }, [projectPath, worktreePath]);

  const resolve = async () => {
    setRunning(true);
    setResolved("");
    try {
      const result = await invoke<string>("run_conflict_resolution", {
        projectPath,
        worktreePath,
        agent,
      });
      setResolved(result);
    } catch (e) {
      setResolved(String(e));
    } finally {
      setRunning(false);
    }
  };

  const commit = async () => {
    setCommitting(true);
    try {
      await invoke("commit_conflict_resolution", {
        projectPath,
        worktreePath,
        message: "resolve merge conflicts",
      });
      onClose();
    } catch (e) {
      console.error("[conflict] commit failed:", e);
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div style={s.bbDiffOverlay}>
      <div style={s.bbDiffDialog}>
        <div style={s.bbDiffHead}>
          <span style={s.bbCardMono}>合并冲突</span>
          <span>· 草稿式：Agent 先给方案，确认后才提交</span>
          <div style={s.bbFill} />
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            关闭
          </button>
        </div>

        <div style={s.bbReviewBody}>
          <div style={s.bbReviewCol}>
            <div style={s.bbFieldLabel}>冲突文件</div>
            <div style={s.bbMemberList}>
              {(ctx?.conflicted_files ?? []).map((file) => (
                <div key={file} style={s.bbMember}>
                  <AlertTriangle size={13} />
                  <span style={s.bbCardMono}>{file}</span>
                </div>
              ))}
              {ctx && ctx.conflicted_files.length === 0 && (
                <div style={s.bbMember}>未检测到冲突。</div>
              )}
            </div>
            <div style={s.bbFieldLabel}>给 Agent 的解决 prompt</div>
            <div style={s.bbReviewRules}>{ctx?.prompt || "加载冲突上下文…"}</div>
          </div>
          <div style={s.bbReviewSide}>
            <div style={s.bbGateHint}>Agent 将修改冲突文件并 git add；提交动作由你确认。</div>
            {resolved && (
              <div style={s.bbSection}>
                <div style={s.bbCardMono}>{resolved}</div>
              </div>
            )}
            <div style={s.bbCardActions}>
              {!resolved ? (
                <button
                  type="button"
                  style={s.bbBtnPrimary}
                  disabled={running || !ctx || ctx.conflicted_files.length === 0}
                  onClick={() => void resolve()}
                >
                  {running ? "解决中…" : "用 Agent 解决冲突"}
                </button>
              ) : (
                <button
                  type="button"
                  style={s.bbBtnPrimary}
                  disabled={committing}
                  onClick={() => void commit()}
                >
                  <CheckCircle2 size={13} />
                  {committing ? "提交中…" : "确认并提交"}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
