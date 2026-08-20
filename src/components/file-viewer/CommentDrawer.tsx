import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import s from "../../styles";
import { useI18n } from "../../i18n";
import type { ReviewComment } from "./reviewComments";

function locationLabel(comment: ReviewComment): string {
  return `${comment.path}:${comment.startLine}${
    comment.endLine !== comment.startLine ? `-${comment.endLine}` : ""
  }`;
}

function snippetPreview(comment: ReviewComment, moreLinesLabel: string): string {
  const lines = comment.snippet.split("\n");
  const first = lines[0] ?? "";
  const extraLines = lines.length - 1;
  return extraLines > 0 ? `${first} … ${moreLinesLabel.replace("{count}", String(extraLines))}` : first;
}

/**
 * FileViewer 底部可折叠评论抽屉（决策 10）：
 * 列表 / 跳转 / 标记已解决 / 编辑 / 删除 / 勾选批量发送 / 单条发送。
 * 纯展示层，数据与发送逻辑在上层。
 */
export function CommentDrawer({
  comments,
  open,
  onToggleOpen,
  onJump,
  onUpdateText,
  onDelete,
  onToggleStatus,
  onSend,
  emptyHint,
}: {
  comments: ReviewComment[];
  open: boolean;
  onToggleOpen: () => void;
  onJump: (comment: ReviewComment) => void;
  onUpdateText: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string) => void;
  onSend: (ids: string[]) => void;
  emptyHint?: string;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const unsentCount = comments.filter((c) => !c.sentAt).length;
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBatchSend = () => {
    const ids = selected.size > 0 ? [...selected] : comments.filter((c) => !c.sentAt).map((c) => c.id);
    if (ids.length > 0) onSend(ids);
  };

  if (!open) {
    return (
      <div style={s.rcDrawerBar} onClick={onToggleOpen} title={t("reviewComments.title")}>
        <span style={s.rcDrawerBarTitle}>
          <MessageSquare size={12} />
          {t("reviewComments.title")}
          <span style={s.rcDrawerBarCount}>{comments.length}</span>
        </span>
        <span style={s.rcDrawerBarChevron}>
          <ChevronUp size={13} />
        </span>
      </div>
    );
  }

  const hasSelection = selected.size > 0;

  return (
    <div style={s.rcDrawer}>
      <div style={s.rcDrawerHeader}>
        <span style={s.rcDrawerHeaderTitle}>
          <MessageSquare size={12} />
          {t("reviewComments.title")} ({comments.length})
        </span>
        <button
          type="button"
          style={s.rcDrawerSendBtn}
          onClick={handleBatchSend}
          disabled={!hasSelection && unsentCount === 0}
          title={
            hasSelection
              ? t("reviewComments.sendSelected", { count: selected.size })
              : t("reviewComments.sendAllUnsent", { count: unsentCount })
          }
        >
          <Send size={12} />
          {hasSelection
            ? t("reviewComments.sendSelected", { count: selected.size })
            : t("reviewComments.sendAllUnsent", { count: unsentCount })}
        </button>
        <button
          type="button"
          style={s.rcDrawerIconBtn}
          onClick={onToggleOpen}
          title={t("reviewComments.collapse")}
          aria-label={t("reviewComments.collapse")}
        >
          <ChevronDown size={14} />
        </button>
      </div>
      <div style={s.rcDrawerList}>
        {comments.length === 0 ? (
          <div style={s.rcDrawerEmpty}>{emptyHint ?? t("reviewComments.empty")}</div>
        ) : (
          comments.map((comment) => {
            const isEditing = editingId === comment.id;
            return (
              <div key={comment.id} style={s.rcDrawerItem} onClick={() => onJump(comment)}>
                <input
                  type="checkbox"
                  checked={selected.has(comment.id)}
                  style={s.rcDrawerItemCheckbox}
                  onChange={(event) => {
                    event.stopPropagation();
                    toggleSelected(comment.id);
                  }}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={locationLabel(comment)}
                />
                <div style={s.rcDrawerItemMain}>
                  <div style={s.rcDrawerItemLoc}>{locationLabel(comment)}</div>
                  {comment.snippet ? (
                    <div style={s.rcDrawerItemSnippet}>
                      {snippetPreview(comment, t("reviewComments.moreLines"))}
                    </div>
                  ) : null}
                  {isEditing ? (
                    <textarea
                      style={s.rcDrawerEditInput}
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      autoFocus
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingId(null);
                          return;
                        }
                        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                          event.preventDefault();
                          const value = editText.trim();
                          if (value) onUpdateText(comment.id, value);
                          setEditingId(null);
                        }
                      }}
                    />
                  ) : (
                    <div style={s.rcDrawerItemText}>{comment.text}</div>
                  )}
                </div>
                <div style={s.rcDrawerItemMeta}>
                  {comment.sentAt ? (
                    <span style={{ ...s.rcDrawerChip, ...s.rcDrawerChipSent }}>
                      {t("reviewComments.sent")}
                    </span>
                  ) : (
                    <span style={{ ...s.rcDrawerChip, ...s.rcDrawerChipOpen }}>
                      {t("reviewComments.unsent")}
                    </span>
                  )}
                  <span
                    style={{
                      ...s.rcDrawerChip,
                      ...(comment.status === "resolved"
                        ? s.rcDrawerChipResolved
                        : s.rcDrawerChipOpen),
                    }}
                  >
                    {comment.status === "resolved"
                      ? t("reviewComments.resolved")
                      : t("reviewComments.open")}
                  </span>
                </div>
                <div style={s.rcDrawerItemActions}>
                  <button
                    type="button"
                    style={s.rcDrawerIconBtnSend}
                    title={t("reviewComments.send")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSend([comment.id]);
                    }}
                  >
                    <Send size={12} />
                  </button>
                  <button
                    type="button"
                    style={s.rcDrawerIconBtn}
                    title={
                      comment.status === "resolved"
                        ? t("reviewComments.unresolve")
                        : t("reviewComments.resolve")
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleStatus(comment.id);
                    }}
                  >
                    <Check size={13} />
                  </button>
                  <button
                    type="button"
                    style={s.rcDrawerIconBtn}
                    title={t("reviewComments.edit")}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isEditing) {
                        const value = editText.trim();
                        if (value) onUpdateText(comment.id, value);
                        setEditingId(null);
                      } else {
                        setEditingId(comment.id);
                        setEditText(comment.text);
                      }
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    style={s.rcDrawerIconBtn}
                    title={t("reviewComments.delete")}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(comment.id);
                      setSelected((prev) => {
                        if (!prev.has(comment.id)) return prev;
                        const next = new Set(prev);
                        next.delete(comment.id);
                        return next;
                      });
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
