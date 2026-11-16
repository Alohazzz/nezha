import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CircleSlash } from "lucide-react";
import type { CodeupMr } from "../../../types";
export function CloseMrDialog({
  mr,
  onClose,
  onConfirm,
}: {
  mr: CodeupMr;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="mh-overlay" />
        <Dialog.Content
          className="mh-dialog mh-close-dialog"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="mh-danger-icon">
            <CircleSlash size={24} />
          </div>
          <Dialog.Title>关闭此合并请求？</Dialog.Title>
          <Dialog.Description>
            关闭后将移出待处理列表。源分支、本地代码与审查报告仍然保留。
          </Dialog.Description>
          <div className="mh-close-target">
            <strong>{mr.title}</strong>
            <span>
              {mr.repository} #{mr.localId}
            </span>
            <code>
              {mr.sourceBranch} → {mr.targetBranch}
            </code>
          </div>
          {error && (
            <p className="mh-error" role="alert">
              {error}
            </p>
          )}
          <div className="mh-dialog-actions">
            <button className="mh-button" disabled={busy} onClick={onClose}>
              暂不关闭
            </button>
            <button
              className="mh-button"
              data-variant="danger"
              disabled={busy}
              onClick={async () => {
                if (lock.current) return;
                lock.current = true;
                setBusy(true);
                setError("");
                try {
                  if (await onConfirm()) onClose();
                } catch (e) {
                  setError(String(e));
                } finally {
                  lock.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? "正在关闭…" : "确认关闭请求"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
