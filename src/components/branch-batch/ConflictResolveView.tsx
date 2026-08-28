import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, X } from "lucide-react";
import s from "../../styles";

interface ConflictContext {
  conflicted_files: string[];
  prompt: string;
}

export function ConflictResolveView({
  projectPath,
  worktreePath,
  onClose,
}: {
  projectPath: string;
  worktreePath: string;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<ConflictContext | null>(null);

  useEffect(() => {
    void invoke<ConflictContext>("get_conflict_context", { projectPath, worktreePath })
      .then(setCtx)
      .catch((e) => console.error("[conflict] load context failed:", e));
  }, [projectPath, worktreePath]);

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
            <div style={s.bbGateHint}>方案确认后由 Agent 解决并 git add；提交动作由你确认。</div>
            <div style={s.bbCardActions}>
              <button type="button" style={s.bbBtnGhost} onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={!ctx || ctx.conflicted_files.length === 0}
                onClick={() => onClose()}
              >
                用 Agent 解决冲突
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
