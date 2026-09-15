import type React from "react";

/**
 * 方案看板样式（**任务为主体**）：方案是可折叠分组表头，任务是主体行。
 * 禁用行内样式（AGENTS.md）；进度条填充的唯一动态值走 `.plan-board-progress-fill`（plan-board.css）。
 */

const planBoardMiniBtn = {
  display: "inline-flex",
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: 3,
  padding: "2px 6px",
  background: "transparent",
  border: "1px solid var(--border-dim)",
  borderRadius: 4,
  color: "var(--text-muted)",
  fontSize: 10.5,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
  transition: "background 0.12s, color 0.12s, border-color 0.12s",
};

const planBoardIconBtn = {
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
};

const planBoardBadge = {
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
    minWidth: 160,
  },

  // ── 方案分组（表头 + 任务行） ──────────────────────────────────────────
  planGroup: {
    display: "flex",
    flexDirection: "column" as const,
    border: "1px solid var(--border-dim)",
    borderRadius: 8,
    marginBottom: 8,
    overflow: "hidden" as const,
  },
  planGroupHeader: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "6px 8px",
    background: "var(--bg-hover)",
    border: "none",
    borderBottom: "1px solid var(--border-dim)",
    width: "100%",
    textAlign: "left" as const,
    cursor: "pointer",
    color: "inherit",
  },
  planGroupHeaderCollapsed: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "6px 8px",
    background: "var(--bg-hover)",
    border: "none",
    width: "100%",
    textAlign: "left" as const,
    cursor: "pointer",
    color: "inherit",
  },
  planGroupName: {
    fontSize: 12,
    fontWeight: 650,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
    maxWidth: 380,
  },
  planGroupSpacer: {
    flex: 1,
    minWidth: 4,
  },
  planGroupActions: {
    display: "flex",
    alignItems: "center" as const,
    gap: 4,
    flexWrap: "wrap" as const,
  },

  // ── 任务行（主体） ────────────────────────────────────────────────────
  taskRows: {
    display: "flex",
    flexDirection: "column" as const,
  },
  taskRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "5px 8px 5px 10px",
    borderBottom: "1px solid var(--border-dim)",
    fontSize: 11.5,
  },
  taskRowLast: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "5px 8px 5px 10px",
    fontSize: 11.5,
  },
  taskRowRunning: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "5px 8px 5px 10px",
    borderBottom: "1px solid var(--border-dim)",
    fontSize: 11.5,
    background: "var(--accent-subtle, var(--bg-hover))",
  },
  taskRowAbnormal: {
    display: "flex",
    alignItems: "center" as const,
    gap: 7,
    padding: "5px 8px 5px 10px",
    borderBottom: "1px solid var(--border-dim)",
    fontSize: 11.5,
    background: "var(--bg-hover)",
    boxShadow: "inset 2px 0 0 var(--danger)",
  },
  taskRowIcon: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center" as const,
    width: 16,
  },
  taskRowSerial: {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--accent)",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
  },
  taskRowSubject: {
    flex: 1,
    minWidth: 0,
    color: "var(--text-primary)",
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  taskRowStatus: {
    flexShrink: 0,
    color: "var(--text-muted)",
    whiteSpace: "nowrap" as const,
  },
  taskRowStatusRunning: {
    flexShrink: 0,
    color: "var(--accent)",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  taskRowStatusFailed: {
    flexShrink: 0,
    color: "var(--danger)",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  /** 前置约束：等 X（未满足）/ 前置异常（红）/ 可开工（绿）。 */
  taskRowDep: {
    flexShrink: 0,
    fontSize: 10.5,
    color: "var(--text-hint)",
    whiteSpace: "nowrap" as const,
  },
  taskRowDepBlocked: {
    flexShrink: 0,
    fontSize: 10.5,
    color: "var(--warning)",
    whiteSpace: "nowrap" as const,
  },
  taskRowDepAbnormal: {
    flexShrink: 0,
    fontSize: 10.5,
    color: "var(--danger)",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  },
  taskRowDepReady: {
    flexShrink: 0,
    fontSize: 10.5,
    color: "var(--success)",
    whiteSpace: "nowrap" as const,
  },
  /** 运行 / 等待时长（等宽数字避免跳动）。 */
  taskRowRuntime: {
    flexShrink: 0,
    fontSize: 10.5,
    color: "var(--text-muted)",
    fontVariantNumeric: "tabular-nums" as const,
    whiteSpace: "nowrap" as const,
  },
  taskRowActions: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 4,
  },

  // ── 表头里的进度 / 徽章 ────────────────────────────────────────────────
  boardProgressRow: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
    minWidth: 110,
    flexShrink: 0,
  },
  boardProgressTrack: {
    flex: 1,
    minWidth: 40,
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
  boardBadgeWaiting: {
    ...planBoardBadge,
  },
  boardBadgeBlocked: {
    ...planBoardBadge,
    borderColor: "var(--danger)",
    color: "var(--danger)",
    fontWeight: 600,
  },
  boardBadgeReady: {
    ...planBoardBadge,
    background: "transparent",
    borderColor: "var(--success)",
    color: "var(--success)",
  },
  boardLockedBadge: {
    ...planBoardBadge,
    color: "var(--text-hint)",
  },
  boardStatusBadge: {
    ...planBoardBadge,
    flexShrink: 0,
  },

  // ── 按钮 ──────────────────────────────────────────────────────────────
  boardMiniBtn: {
    ...planBoardMiniBtn,
  },
  boardMiniBtnDanger: {
    ...planBoardMiniBtn,
    borderColor: "transparent",
    color: "var(--danger)",
  },
  boardIconSlot: {
    display: "inline-flex",
    alignItems: "center" as const,
    flexShrink: 0,
  },
  boardIconBtn: {
    ...planBoardIconBtn,
  },
  /** 展开箭头：展开朝下，收起朝右。 */
  boardChevronExpanded: {
    transform: "rotate(0deg)",
  },
  boardChevronCollapsed: {
    transform: "rotate(-90deg)",
  },

  // ── 已归档区 ──────────────────────────────────────────────────────────
  boardArchiveBar: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
    marginTop: 8,
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
