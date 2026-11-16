import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Send, X } from "lucide-react";
import { MessageMarkdownBody } from "../../mermaid/MessageMarkdownBody";
import type { CodeupMr } from "../../../types";
export function ReviewReportDialog({ mr, onClose }: { mr: CodeupMr; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    void invoke<string | null>("codeup_read_review_report", {
      repository: mr.repository,
      mrId: String(mr.localId),
    })
      .then((report) => {
        if (active) {
          setContent(report ?? "");
          if (!report) setError("该 MR 暂无审查报告，请先执行「代码审查」。");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mr.repository, mr.localId]);
  async function action(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
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
          className="mh-dialog mh-report"
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="mh-report-head">
            <div>
              <Dialog.Title>审查报告</Dialog.Title>
              <Dialog.Description>
                {mr.title} · {mr.repository} #{mr.localId}
              </Dialog.Description>
            </div>
            <button
              className="mh-button"
              aria-label="关闭审查报告"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
          <div className="mh-report-tools">
            <button
              className="mh-button"
              data-variant="primary"
              disabled={!content || busy || draft !== null}
              onClick={() => {
                setDraft(content);
                setNotice("");
                setError("");
              }}
            >
              <Send size={14} />
              回写到评论
            </button>
            <button
              className="mh-button"
              disabled={!content || busy}
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(content);
                  setNotice("审查报告全文已复制到剪贴板。");
                })
              }
            >
              复制
            </button>
            <button
              className="mh-button"
              disabled={!content || busy}
              onClick={() =>
                void action(async () => {
                  const path = await save({
                    defaultPath: `review-report-${mr.localId}.md`,
                    filters: [{ name: "Markdown", extensions: ["md"] }],
                  });
                  if (!path) return;
                  await invoke<void>("codeup_export_review_report", {
                    repository: mr.repository,
                    mrId: String(mr.localId),
                    destPath: path,
                  });
                  setNotice(`审查报告已导出到 ${path}`);
                })
              }
            >
              <Download size={14} />
              导出 .md
            </button>
          </div>
          {error && (
            <div className="mh-message mh-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="mh-message" role="status">
              {notice}
            </div>
          )}
          <div className="mh-report-body">
            {loading ? (
              <p role="status">正在读取审查报告…</p>
            ) : draft !== null ? (
              <>
                <p className="mh-muted">
                  编辑 Markdown 后发布到云效合并请求的整体评论（{mr.sourceBranch} →{" "}
                  {mr.targetBranch}）。
                </p>
                <textarea
                  className="mh-report-editor"
                  aria-label="回写评论内容"
                  disabled={busy}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </>
            ) : content ? (
              <MessageMarkdownBody text={content} className="md-preview" sanitize />
            ) : null}
          </div>
          {draft !== null && (
            <div className="mh-dialog-actions">
              <span className="mh-muted">{draft.length} 字</span>
              <button
                className="mh-button"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                取消编辑
              </button>
              <button
                className="mh-button"
                data-variant="primary"
                disabled={busy || !draft.trim()}
                onClick={() =>
                  void action(async () => {
                    await invoke<string>("codeup_create_mr_comment", {
                      repositoryId: mr.repositoryId,
                      mrId: String(mr.localId),
                      content: draft.trim(),
                    });
                    setDraft(null);
                    setNotice("审查报告已回写到云效合并请求评论。");
                  })
                }
              >
                <Send size={14} />
                {busy ? "发布中…" : "发布评论"}
              </button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
