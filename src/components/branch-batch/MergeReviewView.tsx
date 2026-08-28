import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle2, X } from "lucide-react";
import s from "../../styles";

export function MergeReviewView({
  baseBranch,
  branch,
  onPass,
  onClose,
}: {
  baseBranch: string;
  branch: string;
  onPass: () => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState("");
  const [passed, setPassed] = useState(false);

  useEffect(() => {
    void invoke<string>("get_merge_code_review_instructions")
      .then(setRules)
      .catch((e) => console.error("[merge-review] load rules failed:", e));
  }, []);

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
            <div style={s.bbFieldLabel}>审查规则（来自 merge-code-review Skill，可维护）</div>
            <div style={s.bbReviewRules}>{rules || "加载规则中…"}</div>
          </div>
          <div style={s.bbReviewSide}>
            <div style={s.bbFieldLabel}>审查门禁</div>
            <div style={s.bbCardSub}>
              <span style={s.bbGateHint}>
                {passed ? "已通过" : "未通过 · 合并按钮将置灰"}
              </span>
            </div>
            <div style={s.bbSection}>
              <label style={s.bbMember}>
                <input type="checkbox" checked={passed} onChange={(e) => setPassed(e.target.checked)} />
                <span>标记审查通过</span>
              </label>
            </div>
            <div style={s.bbCardActions}>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={!passed}
                onClick={() => {
                  onPass();
                  onClose();
                }}
              >
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
