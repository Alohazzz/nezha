import { createContext, useContext } from "react";

/**
 * structured 流视图的项目根路径 context（issue #118）。
 * 渲染层条目组件（userMessage 气泡的 localImage 缩略图）需要 projectPath
 * 才能把附件本地路径经 read_image_preview 转成 dataUrl；经 context 下发
 * 避免 renderer 注册表签名扩散。多任务并存安全：每个 CodexStreamView
 * 一个 Provider，条目渲染时读到的是自己任务视图的值。
 */
export const CodexStreamProjectContext = createContext<string | null>(null);

export function useCodexStreamProjectPath(): string | null {
  return useContext(CodexStreamProjectContext);
}
