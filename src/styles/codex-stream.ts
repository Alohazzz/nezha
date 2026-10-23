import type React from "react";

/** codex structured 流视图（issue #116 阶段 3）：条目流 / 审批卡片 / usage 条。 */
export const codexStream = {
  codexStreamRoot: {
    flex: 1,
    overflowY: "auto",
    padding: "16px 28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },

  codexStreamEmpty: {
    color: "var(--text-hint)",
    fontSize: 13,
    padding: "12px 0",
  },

  // ── 通用条目卡片 ──────────────────────────────────────────────────────────

  codexEntryCard: {
    border: "1px solid var(--border-dim)",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12.5,
    background: "var(--bg-root)",
    flexShrink: 0,
  },

  codexEntryHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "6px 12px",
    background: "var(--bg-input)",
    borderBottom: "1px solid var(--border-dim)",
    color: "var(--text-secondary)",
    fontSize: 12,
    width: "100%",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
  },

  codexEntryHeaderLabel: {
    fontFamily: "var(--font-mono)",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: 1,
    minWidth: 0,
  },

  codexEntryHeaderMeta: {
    color: "var(--text-hint)",
    fontSize: 11,
    flexShrink: 0,
  },

  codexEntryBody: {
    margin: 0,
    padding: "8px 12px",
    fontSize: 11.5,
    fontFamily: "var(--font-mono)",
    color: "var(--text-secondary)",
    background: "var(--bg-root)",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 280,
    overflowY: "auto",
  },

  codexEntryBodyRunning: {
    color: "var(--text-hint)",
    fontStyle: "italic",
  },

  codexStatusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  },

  // ── 助手消息 / 思考 ───────────────────────────────────────────────────────

  codexAgentMessage: {
    fontSize: 13.5,
    lineHeight: 1.6,
    color: "var(--text-primary)",
  },

  codexReasoningBlock: {
    borderLeft: "2px solid var(--border-dim)",
    marginLeft: 4,
    padding: "4px 12px",
    fontSize: 12,
    color: "var(--text-muted)",
    fontStyle: "italic",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },

  codexReasoningToggle: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "2px 0",
    color: "var(--text-hint)",
    fontSize: 11.5,
    fontStyle: "italic",
  },

  // ── 审批卡片 ──────────────────────────────────────────────────────────────

  codexApprovalCard: {
    border: "1px solid var(--color-warning)",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12.5,
    flexShrink: 0,
    position: "sticky",
    bottom: 0,
    background: "var(--bg-root)",
    boxShadow: "0 -4px 16px rgba(0,0,0,0.15)",
  },

  codexApprovalHeader: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    padding: "8px 12px",
    color: "var(--color-warning)",
    fontWeight: 600,
    fontSize: 12.5,
    background: "var(--bg-input)",
    borderBottom: "1px solid var(--border-dim)",
  },

  codexApprovalCommand: {
    margin: 0,
    padding: "8px 12px",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    color: "var(--text-primary)",
    background: "var(--bg-root)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 180,
    overflowY: "auto",
  },

  codexApprovalMeta: {
    padding: "4px 12px 0",
    fontSize: 11,
    color: "var(--text-hint)",
    fontFamily: "var(--font-mono)",
    wordBreak: "break-all",
  },

  codexApprovalActions: {
    display: "flex",
    gap: 8,
    padding: "10px 12px",
  },

  codexApprovalApproveBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 14px",
    borderRadius: 6,
    border: "1px solid var(--color-success)",
    background: "transparent",
    color: "var(--color-success)",
    fontSize: 12.5,
    cursor: "pointer",
  },

  codexApprovalApproveBtnHover: {
    background: "var(--color-success)",
    color: "var(--bg-root)",
  },

  codexApprovalDeclineBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 14px",
    borderRadius: 6,
    border: "1px solid var(--border-strong)",
    background: "transparent",
    color: "var(--text-secondary)",
    fontSize: 12.5,
    cursor: "pointer",
  },

  codexApprovalDeclineBtnHover: {
    background: "var(--bg-input)",
  },

  codexApprovalCancelBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 14px",
    borderRadius: 6,
    border: "1px solid var(--color-error)",
    background: "transparent",
    color: "var(--color-error)",
    fontSize: 12.5,
    cursor: "pointer",
  },

  codexApprovalBtnDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  },

  // ── 文件变更 diff ─────────────────────────────────────────────────────────

  codexDiffFileHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    fontSize: 11.5,
    fontFamily: "var(--font-mono)",
    color: "var(--text-secondary)",
    background: "var(--bg-input)",
    borderTop: "1px solid var(--border-dim)",
    wordBreak: "break-all",
  },

  codexDiffPre: {
    margin: 0,
    padding: "6px 12px",
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    lineHeight: 1.45,
    overflowX: "auto",
    whiteSpace: "pre",
    maxHeight: 320,
    overflowY: "auto",
    background: "var(--bg-root)",
    borderTop: "1px solid var(--border-dim)",
  },

  // ── usage 条 ──────────────────────────────────────────────────────────────

  codexUsageBar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "6px 12px",
    borderTop: "1px solid var(--border-dim)",
    fontSize: 11,
    color: "var(--text-hint)",
    fontFamily: "var(--font-mono)",
    flexShrink: 0,
  },

  codexUsageMeter: {
    flex: 1,
    maxWidth: 220,
    height: 4,
    borderRadius: 2,
    background: "var(--bg-input)",
    overflow: "hidden",
  },

  codexUsageMeterFill: {
    height: "100%",
    borderRadius: 2,
    background: "var(--accent)",
  },

  codexUsageMeterFillWarn: {
    background: "var(--color-warning)",
  },

  // ── 继续对话输入框（done 态底部）────────────────────────────────────────────

  codexFollowUpWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: "auto",
    paddingTop: 8,
    flexShrink: 0,
  },

  codexFollowUpBox: {
    display: "flex",
    alignItems: "flex-end",
    gap: 8,
    border: "1px solid var(--border-strong)",
    borderRadius: 10,
    background: "var(--bg-input)",
    padding: "8px 10px",
  },

  codexFollowUpBoxFocused: {
    borderColor: "var(--accent)",
  },

  codexFollowUpInput: {
    flex: 1,
    border: "none",
    outline: "none",
    background: "transparent",
    color: "var(--text-primary)",
    fontSize: 13,
    lineHeight: 1.5,
    resize: "none",
    maxHeight: 160,
    fontFamily: "inherit",
  },

  codexFollowUpSendBtn: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px",
    borderRadius: 8,
    border: "none",
    background: "var(--accent)",
    color: "var(--bg-root)",
    fontSize: 12.5,
    cursor: "pointer",
    flexShrink: 0,
  },

  codexFollowUpSendBtnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },

  // ── 用户消息气泡 ──────────────────────────────────────────────────────────

  codexUserBubbleWrap: {
    display: "flex",
    justifyContent: "flex-end",
  },

  codexUserBubble: {
    maxWidth: "72%",
    padding: "10px 16px",
    background: "var(--bg-subtle)",
    color: "var(--text-primary)",
    borderRadius: 20,
    fontSize: 13.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
} satisfies Record<string, React.CSSProperties>;
