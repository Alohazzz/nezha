import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ShieldAlert, X } from "lucide-react";
import type { CodexApprovalRequest } from "../../types";
import { useI18n } from "../../i18n";

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
  const busyRef = useRef(false);

  const respond = useCallback(
    async (action: ApprovalAction) => {
      if (busyRef.current) return;
      busyRef.current = true;
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
        busyRef.current = false;
        setBusy(false);
        return;
      }
    },
    [request.task_id, request.request_id, onResolved],
  );

  // availableDecisions 是服务端建议的合法子集（小写驼峰决策名）；缺省全部可用。
  // UI 三按钮映射：approve→accept / decline→decline / cancel→cancel。
  const available = request.availableDecisions;
  const allowed = (decision: string) => !available || available.includes(decision);

  return (
    <div className="codex-approval-card">
      <div className="codex-approval-header">
        <ShieldAlert size={13} />
        <span>{t("codex.approval.title")}</span>
        {typeof request.reason === "string" && request.reason && (
          <span className="codex-approval-reason">{request.reason}</span>
        )}
      </div>
      {typeof request.command === "string" && request.command && (
        <pre className="codex-approval-command">{request.command}</pre>
      )}
      {typeof request.cwd === "string" && request.cwd && (
        <div className="codex-approval-meta">cwd: {request.cwd}</div>
      )}
      <div className="codex-stream-approval-actions">
        <button
          type="button"
          className="approve"
          disabled={busy || !allowed("accept")}
          onClick={() => respond("approve")}
        >
          <Check size={12} strokeWidth={2.5} />
          <span>{t("codex.approval.approve")}</span>
        </button>
        <button
          type="button"
          className="decline"
          disabled={busy || !allowed("decline")}
          onClick={() => respond("decline")}
        >
          <X size={12} strokeWidth={2.5} />
          <span>{t("codex.approval.decline")}</span>
        </button>
        <button
          type="button"
          className="cancel"
          disabled={busy || !allowed("cancel")}
          onClick={() => respond("cancel")}
        >
          <X size={12} strokeWidth={2.5} />
          <span>{t("running.cancel")}</span>
        </button>
      </div>
    </div>
  );
}
