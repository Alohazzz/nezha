import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ShieldAlert, X } from "lucide-react";
import type { CodexApprovalRequest } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";

type ApprovalAction = "approve" | "decline" | "cancel";

/**
 * 命令执行审批卡片：sticky 底部展示，三按钮决策。
 * `request_id` 原样回传 `respond_codex_approval`（服务端反向请求 id 空间）；
 * 决策不在服务端 `availableDecisions` 建议子集内时后端报错，前端 toast 由调用方处理。
 * hover / disabled 视觉走 codex-stream.css 的伪类（#117 T3 迁出 inline style）。
 */
export function CodexApprovalCard({
  request,
  onResolved,
}: {
  request: CodexApprovalRequest;
  onResolved: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  const respond = useCallback(
    async (action: ApprovalAction) => {
      if (busy) return;
      setBusy(true);
      try {
        await invoke("respond_codex_approval", {
          taskId: request.task_id,
          requestId: request.request_id,
          action,
        });
        onResolved();
      } catch (err) {
        console.error("respond_codex_approval failed", err);
        setBusy(false);
        return;
      }
    },
    [busy, request.task_id, request.request_id, onResolved],
  );

  // availableDecisions 是服务端建议的合法子集（小写驼峰决策名）；缺省全部可用。
  // UI 三按钮映射：approve→accept / decline→decline / cancel→cancel。
  const available = request.availableDecisions;
  const allowed = (decision: string) => !available || available.includes(decision);

  return (
    <div style={s.codexApprovalCard}>
      <div style={s.codexApprovalHeader}>
        <ShieldAlert size={13} />
        <span>{t("codex.approval.title")}</span>
        {typeof request.reason === "string" && request.reason && (
          <span style={s.codexApprovalReason}>{request.reason}</span>
        )}
      </div>
      {typeof request.command === "string" && request.command && (
        <pre style={s.codexApprovalCommand}>{request.command}</pre>
      )}
      {typeof request.cwd === "string" && request.cwd && (
        <div style={s.codexApprovalMeta}>cwd: {request.cwd}</div>
      )}
      <div style={s.codexApprovalActions} className="codex-stream-approval-actions">
        <button
          type="button"
          className="approve"
          disabled={busy || !allowed("accept")}
          style={s.codexApprovalApproveBtn}
          onClick={() => respond("approve")}
        >
          <Check size={12} strokeWidth={2.5} />
          <span>{t("codex.approval.approve")}</span>
        </button>
        <button
          type="button"
          className="decline"
          disabled={busy || !allowed("decline")}
          style={s.codexApprovalDeclineBtn}
          onClick={() => respond("decline")}
        >
          <X size={12} strokeWidth={2.5} />
          <span>{t("codex.approval.decline")}</span>
        </button>
        <button
          type="button"
          disabled={busy || !allowed("cancel")}
          style={s.codexApprovalCancelBtn}
          onClick={() => respond("cancel")}
        >
          <X size={12} strokeWidth={2.5} />
          <span>{t("running.cancel")}</span>
        </button>
      </div>
    </div>
  );
}
