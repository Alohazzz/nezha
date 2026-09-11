import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitChanges } from "../components/GitChanges";
import { GitHistory } from "../components/GitHistory";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
}));

describe("git panels auto refresh", () => {
  afterEach(() => {
    invokeMock.mockReset();
    vi.useRealTimers();
  });

  it("polls git_status so external commits appear without a manual refresh", async () => {
    let statusCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_status") {
        statusCalls += 1;
        // 第一次为空；外部提交后第二次返回变更。
        return Promise.resolve(
          statusCalls === 1
            ? []
            : [{ path: "src/a.ts", status: "M", staged: true, additions: 1, deletions: 0 }],
        );
      }
      return Promise.resolve(null);
    });

    vi.useFakeTimers();
    render(
      <I18nProvider>
        <GitChanges
          projectRoot="/workspace"
          repoPath="/workspace"
          currentTaskCreatedAt={null}
          onFileSelect={vi.fn()}
          active
        />
      </I18nProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(statusCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  it("does not poll when the project is not visible", async () => {
    let statusCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_status") {
        statusCalls += 1;
        return Promise.resolve([]);
      }
      return Promise.resolve(null);
    });

    vi.useFakeTimers();
    render(
      <I18nProvider>
        <GitChanges
          projectRoot="/workspace"
          repoPath="/workspace"
          currentTaskCreatedAt={null}
          onFileSelect={vi.fn()}
          active={false}
        />
      </I18nProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    const initialCalls = statusCalls;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });

    expect(statusCalls).toBe(initialCalls);
  });

  it("polls git_log so external pushes update the history list", async () => {
    let logCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "git_log") {
        logCalls += 1;
        return Promise.resolve([]);
      }
      if (command === "git_remote_counts") {
        return Promise.resolve({ ahead: 0, behind: 0, branch: "main" });
      }
      if (command === "git_list_branches") {
        return Promise.resolve([{ name: "main", current: true }]);
      }
      return Promise.resolve(null);
    });

    vi.useFakeTimers();
    render(
      <I18nProvider>
        <GitHistory
          projectRoot="/workspace"
          repoPath="/workspace"
          onCommitSelect={vi.fn()}
          active
        />
      </I18nProvider>,
    );

    await act(async () => {
      // 初次挂载：loadBranches → setSelectedBranch → refresh，需要多轮微任务刷新。
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(logCalls).toBeGreaterThanOrEqual(1);
    const initialCalls = logCalls;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(logCalls).toBeGreaterThan(initialCalls);
  });
});
