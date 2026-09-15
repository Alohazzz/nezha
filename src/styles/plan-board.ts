import type React from "react";

/**
 * 方案看板 v2 的**布局**样式对象：只放静态布局/盒模型。
 * 伪类（:hover/:focus-visible）、状态属性（[data-*]）、@keyframes、媒体查询一律放
 * `plan-board.css`（对象表达不了这些）；动画相关类名也在那里定义。
 *
 * 唯一例外是进度条填充宽度：连续的运行时百分比无法用选择器表达，沿用仓库既有约定
 * （参照 build.css / 旧 plan-board.css 的 `.plan-fill`）——视觉规则在 CSS，组件只传 width。
 */

const planMiniBtn = {
  display: "inline-flex",
  alignItems: "center" as const,
  justifyContent: "center" as const,
  gap: 3,
  padding: "2px 7px",
  background: "transparent",
  border: "1px solid var(--border-dim)",
  borderRadius: 5,
  color: "var(--text-muted)",
  fontSize: 10.5,
  cursor: "pointer",
  whiteSpace: "nowrap" as const,
  transition: "background 0.14s ease, color 0.14s ease, border-color 0.14s ease",
};

const planIconBtn = {
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

const planBadge = {
  display: "inline-flex",
  alignItems: "center" as const,
  gap: 3,
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  background: "var(--bg-hover)",
  border: "1px solid var(--border-dim)",
  color: "var(--text-muted)",
  whiteSpace: "nowrap" as const,
};

export const planBoard = {
  /** 浮层内容容器（BoardOverlay 使用；与 kanbanPane 同规格）。 */
  planBoardPane: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minHeight: 0,
    background: "var(--bg-panel)",
  },

  // ── 面包屑 ────────────────────────────────────────────────────────────
  /** 项目节点：既是面包屑的一节，也是项目切换器触发器。 */
  planCrumbProject: {
    display: "inline-flex",
    alignItems: "center" as const,
    gap: 5,
    padding: "3px 7px",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 6,
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.14s ease, border-color 0.14s ease",
  },

  // ── 顶部 Tab 与关闭（沿用任务看板形态） ───────────────────────────────
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

  // ── 详情头部 ──────────────────────────────────────────────────────────
  planStatusBadge: {
    ...planBadge,
    flexShrink: 0,
  },
  planBadgeWaiting: {
    ...planBadge,
  },
  planBadgeReady: {
    ...planBadge,
    background: "transparent",
    borderColor: "var(--success-border)",
    color: "var(--success)",
  },
  planBadgeLocked: {
    ...planBadge,
    color: "var(--text-hint)",
  },

  // ── 按钮 ──────────────────────────────────────────────────────────────
  boardMiniBtn: {
    ...planMiniBtn,
  },
  boardMiniBtnDanger: {
    ...planMiniBtn,
    borderColor: "transparent",
    color: "var(--danger)",
  },
  boardIconBtn: {
    ...planIconBtn,
  },
  boardMiniBtnPrimary: {
    ...planMiniBtn,
    borderColor: "var(--accent-soft)",
    color: "var(--accent)",
  },

  // ── 窄窗返回按钮（仅在窄窗显示，由 CSS 媒体查询控制） ──────────────────
  // ── draft 方案的讨论卡（右栏空图态的替代内容） ─────────────────────────
  planDiscussionCard: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
    padding: 12,
    border: "1px solid var(--border-dim)",
    borderRadius: 8,
    background: "var(--bg-hover)",
  },
  planDiscussionTitle: {
    fontSize: 11.5,
    fontWeight: 650,
    color: "var(--text-primary)",
  },
  planDiscussionHint: {
    fontSize: 11,
    color: "var(--text-muted)",
    lineHeight: 1.6,
  },
  planDiscussionActions: {
    display: "flex",
    alignItems: "center" as const,
    gap: 6,
  },
} satisfies Record<string, React.CSSProperties>;
