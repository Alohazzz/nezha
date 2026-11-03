import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useCodexStream } from "../hooks/useCodexStream";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { I18nProvider } from "../i18n";
import type { CodexApprovalRequest } from "../types";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, callback: (event: { payload: unknown }) => void) => {
    handlers.set(name, callback);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function request(id: number, taskId = "task-1"): CodexApprovalRequest {
  return {
    task_id: taskId, request_id: id, threadId: "thread-1", turnId: "turn-1",
    itemId: `cmd-${id}`, command: `read fixture-${id}.md`, cwd: "C:/fixture",
    availableDecisions: ["accept", "decline", "cancel"],
  };
}

function emit(id: number, taskId = "task-1") {
  handlers.get("codex-approval-requested")!({ payload: request(id, taskId) });
}

function Host() {
  const stream = useCodexStream();
  const state = stream.getStream("task-1");
  return (
    <I18nProvider>
      <CodexStreamView
        entries={state.entries} usage={state.usage} approval={state.approval}
        onApprovalResolved={() => stream.setApprovalResolved("task-1")} running
      />
    </I18nProvider>
  );
}

beforeEach(() => {
  handlers.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  window.localStorage.setItem("nezha:language", "en");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe("concurrent Codex approvals", () => {
  it("shows all three approvals in order and enables each next card", async () => {
    render(<Host />);
    act(() => { emit(0); emit(1); emit(2); });
    for (const id of [0, 1, 2]) {
      expect(await screen.findByText(`read fixture-${id}.md`)).toBeInTheDocument();
      const button = screen.getByRole("button", { name: "Approve" });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("respond_codex_approval", {
        taskId: "task-1", requestId: id, action: "approve",
      }));
    }
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
  });

  it("keeps a newly arrived approval when an earlier response completes", () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => emit(0));
    const finishFirst = result.current.setApprovalResolved;
    act(() => emit(1));
    act(() => finishFirst("task-1"));
    expect(result.current.getStream("task-1").approval?.request_id).toBe(1);
    // Duplicate/late completion of the old request must not clear the next one.
    act(() => finishFirst("task-1"));
    expect(result.current.getStream("task-1").approval?.request_id).toBe(1);
  });

  it("does not clear a replacement session with a reused request id", () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => emit(0));
    const finishOldSession = result.current.setApprovalResolved;
    act(() => result.current.resetTask("task-1"));
    act(() => emit(0));
    act(() => finishOldSession("task-1"));
    expect(result.current.getStream("task-1").approval?.request_id).toBe(0);
  });

  it("deduplicates requests and keeps tasks isolated", () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => { emit(0); emit(0); emit(0, "task-2"); });
    act(() => result.current.setApprovalResolved("task-1"));
    expect(result.current.getStream("task-1").approval).toBeNull();
    expect(result.current.getStream("task-2").approval?.request_id).toBe(0);
  });

  it("keeps failed responses retryable without losing queued approvals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("write failed"));
    render(<Host />);
    act(() => { emit(0); emit(1); });
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
    expect(screen.getByText("read fixture-0.md")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("read fixture-1.md")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("clears all queued approvals when a task ends or starts a follow-up round", () => {
    const { result } = renderHook(() => useCodexStream());
    act(() => { emit(0); emit(1); });
    act(() => result.current.finalizeTask("task-1"));
    expect(result.current.getStream("task-1").approval).toBeNull();
    act(() => { emit(2); emit(3); });
    act(() => result.current.beginFollowUpRound("task-1"));
    expect(result.current.getStream("task-1").approval).toBeNull();
    act(() => emit(4));
    act(() => result.current.setApprovalResolved("task-1"));
    expect(result.current.getStream("task-1").approval).toBeNull();
  });
});
