import type React from "react";

/** 右侧面板（rp-root）的宽度注入：面板宽度由 ProjectPage 统一的可拖拽 rightPanelWidth 驱动。 */
export function rpRootStyle(width: number): React.CSSProperties {
  return { "--rp-width": `${width}px` } as React.CSSProperties;
}
