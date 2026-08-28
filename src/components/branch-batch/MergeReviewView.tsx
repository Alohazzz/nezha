import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, Play, X } from "lucide-react";
import s from "../../styles";

interface ReviewFinding {
  rule: string;
  status: string;
  path: string;
  startLine: number;
  endLine: number;
  message: string;
}

interface LocatedLines {
  file: string;
  lines: string[];
  target: number;
}

export function MergeReviewView({
  projectPath,
  worktreePath,
  baseBranch,
  branch,
  agent,
  onPass,
  onClose,
}: {
  projectPath: string;
  worktreePath: string;
  baseBranch: string;
  branch: string;
  agent: string;
  onPass: () => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState("");
  const [findings, setFindings] = useState<ReviewFinding[]>([]);
  const [running, setRunning] = useState(false);
  const [passed, setPassed] = useState(false);
  const [located, setLocated] = useState<LocatedLines | null>(null);

  useEffect(() => {
    void invoke<string>("get_merge_code_review_instructions")
      .then(setRules)
      .catch((e) => console.error("[merge-review] load rules failed:", e));
  }, []);

  const locate = useCallback(
    async (f: ReviewFinding) => {
      if (!f.path || f.startLine <= 0) return;
      try {
        const full = await invoke<string>("read_file_content", {
          path: `${worktreePath}/${f.path}`,
          projectPath: worktreePath,
        });
        const all = full.split("\n");
        const start = Math.max(0, f.startLine - 3);
        const end = Math.min(all.length, f.startLine + 2);
        setLocated({
          file: f.path,
          lines: all.slice(start, end),
          target: Math.max(0, f.startLine - 1 - start),
        });
      } catch (e) {
        console.error("[merge-review] locate failed:", e);
      }
    },
    [worktreePath],
  );

  const run = useCallback(async () => {
    setRunning(true);
    setFindings([]);
    setLocated(null);
    try {
      const result = await invoke<ReviewFinding[]>("run_merge_code_review", {
        projectPath,
        worktreePath,
        baseBranch,
        branch,
        agent,
      });
      setFindings(result);
    } catch (e) {
      console.error("[merge-review] run failed:", e);
    } finally {
      setRunning(false);
    }
  }, [projectPath, worktreePath, baseBranch, branch, agent]);

  const hasFail = findings.some((f) => f.status === "fail");

  return (
    <div style={s.bbDiffOverlay}>
      <div style={s.bbDiffDialog}>
        <div style={s.bbDiffHead}>
          <span style={s.bbCardMono}>{branch}</span>
          <span>→ {baseBranch} · 合并代码审查（Agent + Skill 规则）</span>
          <div style={s.bbFill} />
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            关闭
          </button>
        </div>

        <div style={s.bbReviewBody}>
          <div style={s.bbReviewCol}>
            <div style={s.bbToolbar}>
              <button type="button" style={s.bbBtnPrimary} disabled={running} onClick={() => void run()}>
                <Play size={13} />
                {running ? "审查中…" : "运行 Agent 审查"}
              </button>
              <span style={s.bbFieldLabel}>审查规则自 merge-code-review Skill（可维护）</span>
            </div>
            <div style={s.bbReviewRules}>{rules || "加载规则中…"}</div>

            {findings.map((f, i) => (
              <div key={i} style={s.bbCardSub}>
                <span style={f.status === "fail" ? s.bbBadgeConflict : f.status === "warn" ? s.bbBadgeWarn : s.bbBadgeDone}>
                  {f.status === "fail" ? "阻止" : f.status === "warn" ? "警告" : "通过"}
                </span>
                <span>{f.rule}</span>
                {f.path && f.startLine > 0 && (
                  <span style={s.bbLocate} onClick={() => void locate(f)}>
                    {f.path}:{f.startLine} ▸
                  </span>
                )}
                <span style={s.bbCardMono}>{f.message}</span>
              </div>
            ))}
            {findings.length === 0 && !running && <div style={s.bbEmpty}>尚未审查，点击上方按钮。</div>}
          </div>

          <div style={s.bbReviewSide}>
            <div style={s.bbFieldLabel}>定位代码</div>
            {located ? (
              <div>
                <div style={s.bbCardMono}>{located.file}</div>
                {located.lines.map((line, idx) => (
                  <div key={idx} style={located.target === idx ? s.bbCodeLineActive : s.bbCodeLine}>
                    <span style={s.bbCodeGutter}>{located.target === idx ? "▸" : "\u00a0"}</span>
                    <span style={s.bbCodeNum}>{located.target - 2 + idx + 1}</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div style={s.bbEmpty}>点击审查项的 <span style={s.bbCardMono}>path:行号 ▸</span> 定位</div>
            )}
            <div style={s.bbFieldLabel}>审查门禁</div>
            <div style={s.bbCardSub}>
              <span style={s.bbGateHint}>{hasFail ? "存在阻止项 · 需先解决" : passed ? "已通过" : "未通过 · 合并按钮置灰"}</span>
            </div>
            <label style={s.bbMember}>
              <input type="checkbox" checked={passed} onChange={(e) => setPassed(e.target.checked)} />
              <span>标记审查通过</span>
            </label>
            <div style={s.bbCardActions}>
              <button type="button" style={s.bbBtnPrimary} disabled={!passed || hasFail} onClick={() => { onPass(); onClose(); }}>
                <CheckCircle2 size={13} />
                确认放行
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
