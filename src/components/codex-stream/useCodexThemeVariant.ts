import type { ThemeVariant } from "../../types";
import { useSyncExternalStore } from "react";

// 主题信号（issue #117 T4）：App.tsx 在 <html> 上切换 dark + 各暗色变体
// （midnight / zinc / claude）/ eyecare class（无 class = light）。变体 class
// 叠在 `dark` 之上，所以判定顺序必须先查变体再查 dark。useIsLightTheme 只给
// 明暗二值，diff 高亮需要完整 variant 精确映射 shiki 主题，故这里复用同一
// MutationObserver 扇出模式读完整 variant。与 App.tsx 的 toggle 逻辑保持同一
// 真源（html class）。

export type CodexThemeVariant = ThemeVariant;

const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!observer) {
    observer = new MutationObserver(() => listeners.forEach((notify) => notify()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): CodexThemeVariant {
  const root = document.documentElement;
  if (root.classList.contains("midnight")) return "midnight";
  if (root.classList.contains("zinc")) return "zinc";
  if (root.classList.contains("claude")) return "claude";
  if (root.classList.contains("eyecare")) return "eyecare";
  if (root.classList.contains("dark")) return "dark";
  return "light";
}

export function useCodexThemeVariant(): CodexThemeVariant {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
