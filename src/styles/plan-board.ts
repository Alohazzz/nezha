import type React from "react";

/**
 * 方案看板（PlanBoard）样式：容器 / 顶部工具条 / Tab / 生命周期列点 / 方案卡片 /
 * 进度条 / 依赖摘要 / 议题展开行 / 卡片动作按钮。禁用行内样式（AGENTS.md）。
 */

const planBoardCard = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 4,
  padding: "6px 7px",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 6,
  cursor: "pointer",
  textAlign: "left" as const,
  width: "100%",
  transition: "background 0.12s, border-color 0.12s",
};

const planBoardMiniBtn = {
  display: "inline-flex",
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: 3,
  padding: "2px 5px",
  background: "transparent",
  border: "1px solid var(--border-dim)",
  borderRadius: 4,
  color: "var(--text-muted)",
  fontSize: 10.5,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
  transition: "background 0.12s, color 0.12s, border-color 0.12s",
};

export const planBoard = {
  /** 看板浮层内容容器（Tab 化后由 BoardOverlay 使用；与 kanbanPane 同规格）。 */
  planBoardPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    overflowY: "auto" as const,
    background: "var(--bg-panel)",
    padding: "16px 20px 20px",
  },
  // ── 顶部工具条 ─────────────────────────────────────────────────────────
  boardToolbar: {
    display: "flex",
    alignItems: "center" as const,
    gap: 8,
    marginBottom: 10,
    flexWrap: "wrap" as const,
  },
  boardTabs: {
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 2,
    padding: 2,
    background: "var(--bg-hover)",
    borderRadius: 7,
  },
  boardTab: {
    padding: "3px 12px",
    background: "transparent",
    border: "none",
    borderRadius: 5,
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--text-muted)",
    cursor: "pointer",
    transition: "background 0.12s, color 0.12s",
  },
  boardTabActive: {
    padding: "3px 12px",
    background: "var(--bg-card)",
    border: "none",
    borderRadius: 5,
    fontSize: 11.5,
    fontWeight: 600,
    color: "var(--text-primary)",
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(0,0,0,0.12)",
  },
  boardFilterInput: {
    marginLeft: "auto",
    padding: "3px 8px",
    background: "var(--bg-card)",
    border: "1px solid var(--border-dim)",
    borderRadius: 6,
    color: "var(--text-primary)",
    fontSize: 11.5,
    outline: "none",
    minWidth: 150,
  },

  // ── 列 ────────────────────────────────────────────────────────────────
  // 生命周期列：与 kanbanColumns（4 列）不同，方案看板主列固定 5 个。
  boardColumns: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: 10,
  },
  boardColumnDotDraft: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: "var(--text-hint)",
  },
  boardColumnDotFinalized: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: "var(--accent)",
  },
  boardColumnDotExecuting: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: "var(--warning)",
  },
  boardColumnDotCompleted: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: "var(--success)",
  },
  boardColumnDotCancelled: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    background: "var(--danger)",
  },

  // ── 卡片 ──────────────────────────────────────────────────────────────
  boardCard: {
    ...planBoardCard,
  },
  boardCardHover: {
    ...planBoardCard,
    background: "var(--bg-hover)",
    borderColor: "var(--border-medium)",
  },
  boardCardHead: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
    minWidth: 0,
  },
  boardCardName: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  /** 子方案归属标记「↳ 主方案名」。 */
  boardCardSerials: {
    display: "flex",
    alignItems: "center" as const,
    gap: 3,
    flexWrap: "wrap" as const,
  },
  /** 议题编号 chip；状态色由 done 与否决定（两条规则）。 */
  boardSerialChip: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--border-dim)",
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
  },
  boardSerialChipDone: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "transparent",
    border: "1px solid var(--success)",
    color: "var(--success)",
    whiteSpace: "nowrap" as const,
  },
  boardSerialChipBlocked: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--warning)",
    color: "var(--warning)",
    whiteSpace: "nowrap" as const,
  },
  boardSerialChipFailed: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--danger)",
    color: "var(--danger)",
    whiteSpace: "nowrap" as const,
  },

  // ── 进度条 ────────────────────────────────────────────────────────────
  boardProgressRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
  },
  boardProgressTrack: {
    flex: 1,
    minWidth: 0,
    height: 4,
    borderRadius: 2,
    background: "var(--border-dim)",
    overflow: "hidden" as const,
  },
  boardProgressLabel: {
    fontSize: 10.5,
    color: "var(--text-muted)",
    fontVariantNumeric: "tabular-nums" as const,
    whiteSpace: "nowrap" as const,
  },

  // ── 依赖 / 状态摘要 ────────────────────────────────────────────────────
  boardSummaryRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 5,
    flexWrap: "wrap" as const,
  },
  boardBadgeWaiting: {
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 3,
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--border-dim)",
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
  },
  /** 「全部议题已完成，可标记完成」提示徽章（提示而不代改状态）。 */
  boardBadgeReady: {
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 3,
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "transparent",
    border: "1px solid var(--success)",
    color: "var(--success)",
    whiteSpace: "nowrap" as const,
  },
  boardLockedBadge: {
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 3,
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--border-dim)",
    color: "var(--text-hint)",
    whiteSpace: "nowrap" as const,
  },

  // ── 卡片动作 ──────────────────────────────────────────────────────────
  boardCardActions: {
    display: "flex",
    alignItems: "center" as const,
    gap: 4,
    flexWrap: "wrap" as const,
    marginTop: 2,
  },
  boardMiniBtn: {
    ...planBoardMiniBtn,
  },
  boardMiniBtnDanger: {
    ...planBoardMiniBtn,
    borderColor: "transparent",
    color: "var(--danger)",
  },
  /** 图标槽（状态图标）与纯图标按钮。 */
  boardIconSlot: {
    display: "inline-flex",
    alignItems: "center" as const,
    flexShrink: 0,
  },
  boardIconBtn: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center" as const,
    justifyContent: "center" as const,
    padding: 2,
    background: "transparent",
    border: "none",
    borderRadius: 4,
    color: "var(--text-hint)",
    cursor: "pointer",
  },
  /** 议题展开箭头：展开朝下，收起朝右。 */
  boardChevronExpanded: {
    transform: "rotate(0deg)",
  },
  boardChevronCollapsed: {
    transform: "rotate(-90deg)",
  },
  /** 生命周期徽章（卡片上的 PlanStatus 文案）。 */
  boardStatusBadge: {
    fontSize: 10,
    padding: "1px 5px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    border: "1px solid var(--border-dim)",
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
  },

  // ── 议题展开行 ────────────────────────────────────────────────────────
  boardIssueRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
    padding: "3px 4px",
    borderRadius: 4,
    background: "var(--bg-hover)",
    fontSize: 10.5,
  },
  boardIssueSerial: {
    fontWeight: 700,
    color: "var(--accent)",
    whiteSpace: "nowrap" as const,
  },
  boardIssueSubject: {
    flex: 1,
    minWidth: 0,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  boardIssueStatus: {
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
  },
  boardIssueStatusFailed: {
    color: "var(--danger)",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  boardIssueDeps: {
    color: "var(--text-hint)",
    whiteSpace: "nowrap" as const,
  },
  boardIssueList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginTop: 4,
  },

  // ── 已归档区 ──────────────────────────────────────────────────────────
  boardArchiveBar: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
    marginTop: 10,
    padding: "4px 6px",
    background: "transparent",
    border: "1px dashed var(--border-dim)",
    borderRadius: 6,
    color: "var(--text-muted)",
    fontSize: 11,
    cursor: "pointer",
    width: "fit-content" as const,
  },
  boardArchiveList: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
    marginTop: 6,
  },
  boardArchiveRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 8,
    padding: "4px 6px",
    borderRadius: 5,
    border: "1px solid var(--border-dim)",
  },
  boardArchiveName: {
    flex: 1,
    minWidth: 0,
    fontSize: 11.5,
    color: "var(--text-muted)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
} satisfies Record<string, React.CSSProperties>;
