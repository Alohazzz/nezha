import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_MAX_BYTES,
  truncateOutputTail,
  type TruncatedOutput,
} from "../components/codex-stream/codexEntryShared";

// T5（issue #117）：命令输出尾部截断——展开区只渲染尾部 ~64KB 量级（spec
// Solution #5「命令卡」、user story 15）。全量输出始终保留在内存条目上，
// 复制全文按钮复制的是完整文本；这里只测纯函数接缝。

const KB = 1024;

/** 造 n 行文本，每行带行号，总大小可预期。 */
function lines(n: number, pad = 0): string {
  const row: string[] = [];
  for (let i = 1; i <= n; i++) row.push(`line-${String(i).padStart(6, "0")}${"x".repeat(pad)}`);
  return row.join("\n");
}

describe("truncateOutputTail", () => {
  it("returns output unchanged (no truncation) when under the byte cap", () => {
    const small = lines(10);
    const result = truncateOutputTail(small);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(small);
    expect(result.omittedLines).toBe(0);
    expect(result.totalLines).toBe(10);
  });

  it("returns empty output as non-truncated empty text", () => {
    const result = truncateOutputTail("");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("");
  });

  it("handles null/undefined output", () => {
    expect(truncateOutputTail(null).text).toBe("");
    expect(truncateOutputTail(undefined).truncated).toBe(false);
  });

  it("keeps only the tail when output exceeds the byte cap (~64KB)", () => {
    // ~2000 行 × ~120B ≈ 240KB，远超 64KB 上限
    const big = lines(2000, 100);
    expect(big.length).toBeGreaterThan(128 * KB);

    const result: TruncatedOutput = truncateOutputTail(big);
    expect(result.truncated).toBe(true);
    // 尾部文本严格小于上限（按行取尾，不会越界半个 64KB 太多）
    expect(result.text.length).toBeLessThanOrEqual(64 * KB + 4096);
    // 是"尾部"：以最后一行结尾，不以第一行开头
    expect(result.text.endsWith("line-002000" + "x".repeat(100))).toBe(true);
    expect(result.text.startsWith("line-000001")).toBe(false);
    // 元数据：省略行数 = 总行数 - 保留行数
    const keptLines = result.text.split("\n").length;
    expect(result.totalLines).toBe(2000);
    expect(result.omittedLines).toBe(2000 - keptLines);
    expect(result.omittedLines).toBeGreaterThan(0);
  });

  it("drops whole lines only — never splits a line mid-way (tail anchor at line boundary)", () => {
    // 一行超长（> 64KB）：按行取尾时保留行数可为 0 的边界不炸，退回整行尾部
    const hugeSingleLine = "y".repeat(200 * KB);
    const result = truncateOutputTail(hugeSingleLine);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(1);
    // 单行超上限：保留行尾硬切片，严格不超过上限
    expect(result.text.length).toBe(OUTPUT_TAIL_MAX_BYTES);
    expect(result.text.endsWith("y")).toBe(true);
  });

  it("keeps the cap stable for pathologically long line runs", () => {
    const result = truncateOutputTail(lines(50, 8192)); // ~400KB, 50 lines
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(64 * KB + 8192);
  });
});
