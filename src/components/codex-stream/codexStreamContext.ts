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

/**
 * 当前这一轮是否仍在进行（CodexStreamView 的 `running`）。
 *
 * 用途：子智能体卡片没有自己的「轮次」概念——如果子智能体没来得及发 completed
 * 事件父轮就结束了（被取消 / 进程退出 / 事件丢失），卡片会永远停在「运行中」，
 * 用户看到界面还在转、任务其实已经结束。卡片据此在轮次结束时收口。
 */
export const CodexStreamTurnActiveContext = createContext(false);

export function useCodexStreamTurnActive(): boolean {
  return useContext(CodexStreamTurnActiveContext);
}
