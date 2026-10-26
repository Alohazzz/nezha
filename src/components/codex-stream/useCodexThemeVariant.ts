import { useSyncExternalStore } from "react";

// 四主题信号（issue #117 T4）：App.tsx 在 <html> 上切换 dark / midnight / eyecare
// class（两两组合表达四主题；无 class = light）。useIsLightTheme 只给明暗二值，
// diff 高亮需要四值精确映射 shiki 主题，故这里复用同一 MutationObserver 扇出
// 模式读完整 variant。与 App.tsx 的 toggle 逻辑保持同一真源（html class）。

export type CodexThemeVariant = "dark" | "midnight" | "light" | "eyecare";

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
  if (root.classList.contains("eyecare")) return "eyecare";
  if (root.classList.contains("dark")) return "dark";
  return "light";
}

export function useCodexThemeVariant(): CodexThemeVariant {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
