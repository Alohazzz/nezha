import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexWorkingIndicator } from "../components/codex-stream/CodexWorkingIndicator";
import { formatDuration, splitElapsedSeconds } from "../components/codex-stream/codexEntryShared";

// 流视图级「工作中」指示器的时长换算：裸秒数（如 659 秒）无法一眼读出量级，
// 需按 秒 / 分秒 / 时分秒 三档展示。条目卡（命令 / MCP / 子智能体 / 协作）
// 的定格时长共用 formatDuration，同步覆盖。

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
});

function renderIndicator() {
  return render(
    <I18nProvider>
      <CodexWorkingIndicator />
    </I18nProvider>,
  );
}

describe("splitElapsedSeconds", () => {
  it("splits seconds into hours/minutes/seconds and clamps invalid input", () => {
    expect(splitElapsedSeconds(0)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
    expect(splitElapsedSeconds(59)).toEqual({ hours: 0, minutes: 0, seconds: 59 });
    expect(splitElapsedSeconds(659)).toEqual({ hours: 0, minutes: 10, seconds: 59 });
    expect(splitElapsedSeconds(3661)).toEqual({ hours: 1, minutes: 1, seconds: 1 });
    expect(splitElapsedSeconds(-5)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
    expect(splitElapsedSeconds(Number.NaN)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
  });
});

describe("formatDuration", () => {
  it("keeps sub-minute precision and switches to split units past a minute", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(59_400)).toBe("59.4s");
    expect(formatDuration(186_000)).toBe("3m 6s");
    expect(formatDuration(659_000)).toBe("10m 59s");
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
  });
});

describe("CodexWorkingIndicator", () => {
  it("renders bare seconds under a minute", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("nezha:language", "zh");
    renderIndicator();
    expect(screen.getByRole("status").textContent).toBe("工作中 · 0 秒");

    act(() => {
      vi.advanceTimersByTime(42_000);
    });
    expect(screen.getByRole("status").textContent).toBe("工作中 · 42 秒");
  });

  it("switches to minutes once past 60s (659s → 10 分 59 秒)", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("nezha:language", "zh");
    renderIndicator();

    act(() => {
      vi.advanceTimersByTime(659_000);
    });
    expect(screen.getByRole("status").textContent).toBe("工作中 · 10 分 59 秒");
  });

  it("switches to hours once past 3600s", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("nezha:language", "zh");
    renderIndicator();

    act(() => {
      vi.advanceTimersByTime(3_661_000);
    });
    expect(screen.getByRole("status").textContent).toBe("工作中 · 1 小时 1 分 1 秒");
  });

  it("uses the English unit labels in English", () => {
    vi.useFakeTimers();
    window.localStorage.setItem("nezha:language", "en");
    renderIndicator();

    act(() => {
      vi.advanceTimersByTime(659_000);
    });
    expect(screen.getByRole("status").textContent).toBe("Working · 10m 59s");
  });
});
