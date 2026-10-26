// codex-stream 条目卡共享的小工具函数（issue #117 T3 拆分 CodexEntryItems 后的落点）。

/** 毫秒时长 → "850ms" / "1.2s"；无时长返回空串。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** JSON 值 → 稳定的两空格缩进文本；序列化失败退回 String()。 */
export function formatJsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
