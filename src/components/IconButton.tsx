import { useState } from "react";
import type { ReactNode } from "react";

export function IconButton({
  icon,
  title,
  active = false,
  disabled = false,
  onClick,
  size = 32,
  badge = 0,
}: {
  icon: ReactNode;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  size?: number;
  /** 角标数量：> 0 时在图标右上角显示一个红点，提示「有待处理内容」（如待确认的知识变更）。 */
  badge?: number;
}) {
  const [hovered, setHovered] = useState(false);
  const showHover = hovered && !disabled && !active;
  const showBadge = badge > 0;

  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      data-badge={showBadge || undefined}
      style={{
        width: size,
        height: size,
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? "var(--control-active-bg)" : showHover ? "var(--bg-hover)" : "none",
        border: "none",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        color: active ? "var(--control-active-fg)" : showHover ? "var(--text-muted)" : "var(--text-hint)",
        opacity: disabled ? 0.4 : 1,
        transition: "background 0.12s, color 0.12s",
        flexShrink: 0,
      }}
    >
      {icon}
      {showBadge && <span className="icon-btn-badge" aria-hidden="true" />}
    </button>
  );
}
