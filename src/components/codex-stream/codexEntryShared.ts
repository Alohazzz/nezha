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

// ── 命令输出尾部截断（issue #117 T5，spec Solution #5「命令卡」/ user story 15）──
// 展开区只渲染输出尾部（~64KB 量级、按整行取尾）；全量输出保留在内存条目上，
// 复制全文按钮复制完整文本。失败 tooltip 的错误详情喂同一份尾部逻辑（T2/T3
// 的 tooltip 自身再做 2000 字符级裁剪，双层收敛）。

/** 展开区渲染的字节上限（~64KB 量级）。 */
export const OUTPUT_TAIL_MAX_BYTES = 64 * 1024;

/** 尾部截断结果：text 供渲染，元数据供截断提示。 */
export interface TruncatedOutput {
  /** 供渲染的文本（截断时为尾部；未截断时原样）。 */
  text: string;
  truncated: boolean;
  /** 被省略的行数（按 "\n" 计；截断时 > 0）。 */
  omittedLines: number;
  /** 原始输出总行数。 */
  totalLines: number;
}

/**
 * 把命令输出收敛为尾部：从字节上限对应的行边界开始保留整行，绝不把一行
 * 劈成两半（首尾对不齐会导致 diff 式阅读错位）。单行超上限时退回该行的
 * 行尾切片（slack 容差内）。全量文本仍由调用方持有——这里只裁剪渲染面。
 */
export function truncateOutputTail(
  output: string | null | undefined,
  maxBytes: number = OUTPUT_TAIL_MAX_BYTES,
): TruncatedOutput {
  if (!output) return { text: "", truncated: false, omittedLines: 0, totalLines: 0 };

  if (output.length <= maxBytes) {
    // 未超上限：原样渲染。totalLines 按 "\n" 计，末尾换行产生的空尾行不计。
    const total = countLines(output);
    return { text: output, truncated: false, omittedLines: 0, totalLines: total };
  }

  const totalLines = countLines(output);
  // 从 (len - maxBytes) 前一个 "\n" 处切开，保证切片起点是行边界
  const lowerBound = Math.max(0, output.length - maxBytes - 1);
  let start = output.indexOf("\n", Math.max(0, lowerBound));
  if (start === -1) {
    // 上限窗口内没有任何换行（单行超长）：退回行尾硬切片（保持 ≤ 上限）
    return {
      text: output.slice(-maxBytes),
      truncated: true,
      omittedLines: 0,
      totalLines,
    };
  }
  start += 1; // 跳过换行符，从下一行行首开始
  const text = output.slice(start);
  const keptLines = countLines(text);
  return {
    text,
    truncated: true,
    omittedLines: totalLines - keptLines,
    totalLines,
  };
}

/** 行数统计：按 "\n" 出现次数计，末尾换行不产生多余空行计数。 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  if (text.endsWith("\n")) count--;
  return count;
}
