import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { usePromptPrediction, type PromptPredictionState } from "../components/codex-stream/usePromptPrediction";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(), handler: null as null | ((event: { payload: unknown }) => void),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));

const state = (revision: number, status = "complete"): PromptPredictionState => ({
  taskId: "task", threadId: "thread", sourceTurnId: "turn", sessionGeneration: 3,
  revision, status, suggestion: status === "complete" ? "Run the tests." : null,
  model: "gpt-6-astra", effort: "high", parentEffort: "medium", promptVersion: "nezha-next-message-v1", createdAt: 1,
});
beforeEach(() => {
  bridge.invoke.mockReset(); bridge.listen.mockReset(); bridge.handler = null;
  bridge.listen.mockImplementation(async (_name: string, handler: typeof bridge.handler) => {
    bridge.handler = handler; return vi.fn();
  });
});

test("an invalidation arriving during cache read cannot be resurrected by the old read", async () => {
  let resolve!: (value: PromptPredictionState) => void;
  bridge.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const { result } = renderHook(() => usePromptPrediction("task", "thread", true));
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
  act(() => bridge.handler?.({ payload: state(2, "invalidated") }));
  await act(async () => { resolve(state(1)); });
  expect(result.current.suggestion).toBeNull();
});

test("the previous completed round is hidden immediately when a new round completes", async () => {
  bridge.invoke.mockResolvedValue(state(10));
  const { result, rerender } = renderHook(({ done }) => usePromptPrediction("task", "thread", done), { initialProps: { done: true } });
  await waitFor(() => expect(result.current.suggestion).toBe("Run the tests."));
  rerender({ done: false });
  bridge.invoke.mockImplementation(() => new Promise(() => {}));
  rerender({ done: true });
  expect(result.current.suggestion).toBeNull();
});


test("switching task or settings hides the old suggestion before effects settle", async () => {
  bridge.invoke.mockResolvedValue(state(20));
  const { result, rerender } = renderHook(({ task, fingerprint }) => usePromptPrediction(task, "thread", true, fingerprint), {
    initialProps: { task: "task", fingerprint: "medium" },
  });
  await waitFor(() => expect(result.current.suggestion).toBe("Run the tests."));
  bridge.invoke.mockResolvedValue(state(20));
  rerender({ task: "task", fingerprint: "high" });
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(2));
  expect(result.current.suggestion).toBeNull();
  rerender({ task: "other", fingerprint: "high" });
  act(() => bridge.handler?.({ payload: state(21) }));
  expect(result.current.suggestion).toBeNull();
});

test("typing while pending suppresses a late result and the same round after remount", async () => {
  const pending = { ...state(30, "pending"), sourceTurnId: "suppressed-turn" };
  bridge.invoke.mockResolvedValue(pending);
  const first = renderHook(() => usePromptPrediction("task", "thread", true));
  await waitFor(() => expect(first.result.current.state?.revision).toBe(30));
  act(() => first.result.current.suppress());
  const completed = { ...pending, revision: 31, status: "complete", suggestion: "Do not restore this draft." };
  act(() => bridge.handler?.({ payload: completed }));
  expect(first.result.current.suggestion).toBeNull();
  first.unmount();
  bridge.invoke.mockResolvedValue(completed);
  const second = renderHook(() => usePromptPrediction("task", "thread", true));
  await waitFor(() => expect(second.result.current.state?.revision).toBe(31));
  expect(second.result.current.suggestion).toBeNull();
});
