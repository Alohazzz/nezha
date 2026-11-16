import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PromptPredictionState {
  taskId: string;
  threadId: string;
  sourceTurnId: string;
  sessionGeneration: number;
  revision: number;
  status: string;
  suggestion: string | null;
  promptVersion: string;
  model: string;
  effort: string;
  parentEffort: string | null;
  createdAt: number;
}

const suppressed = new Set<string>();
const roundKey = (state: PromptPredictionState) => JSON.stringify([state.taskId, state.threadId, state.sourceTurnId, state.sessionGeneration]);
const validSuggestion = (text: unknown): text is string => typeof text === "string"
  && text.trim().length > 0 && !/[\r\n\u0085\u2028\u2029]/u.test(text) && Array.from(text).length <= 240;

/** Local, low-frequency subscription; mounting reads cache and never starts a model request. */
export function usePromptPrediction(taskId: string | undefined, threadId: string | undefined, eligible: boolean, fingerprint?: string) {
  const [state, setState] = useState<PromptPredictionState | null>(null);
  const [suppressedRound, setSuppressedRound] = useState<string | null>(null);
  const current = useRef({ taskId, threadId, eligible });
  current.current = { taskId, threadId, eligible };
  const identity = JSON.stringify([taskId, threadId, eligible, fingerprint]);
  const epoch = useRef({ identity, value: 0 });
  if (epoch.current.identity !== identity) epoch.current = { identity, value: epoch.current.value + 1 };
  const acceptedEpoch = useRef(-1);
  const stateRef = useRef(state);
  stateRef.current = state;
  const suppressBeforeRead = useRef<string | null>(null);

  const previousSettings = useRef({ taskId, threadId, fingerprint });
  useEffect(() => {
    const previous = previousSettings.current;
    previousSettings.current = { taskId, threadId, fingerprint };
    if (previous.taskId === taskId && previous.threadId === threadId && previous.fingerprint !== fingerprint) {
      const snapshot = stateRef.current;
      if (snapshot && snapshot.taskId === taskId && snapshot.threadId === threadId) {
        suppressed.add(roundKey(snapshot));
        if (suppressed.size > 100) suppressed.delete(suppressed.values().next().value!);
      } else suppressBeforeRead.current = JSON.stringify([taskId, threadId]);
    }
    if (!taskId || !threadId || !eligible) { suppressBeforeRead.current = null; return; }
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let revision = -1;
    const subscriptionEpoch = epoch.current.value;
    const accept = (next: PromptPredictionState | null) => {
      if (disposed || epoch.current.value !== subscriptionEpoch || !next || current.current.taskId !== taskId || current.current.threadId !== threadId
        || !current.current.eligible || next.taskId !== taskId || next.threadId !== threadId
        || !Number.isSafeInteger(next.sessionGeneration) || !Number.isSafeInteger(next.revision)
        || next.revision <= revision) return;
      revision = next.revision;
      acceptedEpoch.current = subscriptionEpoch;
      if (suppressBeforeRead.current === JSON.stringify([taskId, threadId])) {
        suppressed.add(roundKey(next));
        if (suppressed.size > 100) suppressed.delete(suppressed.values().next().value!);
        suppressBeforeRead.current = null;
      }
      setState(next);
    };
    void (async () => {
      try {
        unlisten = await listen<PromptPredictionState>("codex-prompt-prediction", ({ payload }) => accept(payload));
        if (disposed) { unlisten(); return; }
        accept(await invoke<PromptPredictionState | null>("get_codex_prompt_prediction", { taskId, threadId }));
      } catch { /* Optional suggestions never affect the composer or toast. */ }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [taskId, threadId, eligible, fingerprint]);

  const suppress = useCallback(() => {
    const snapshot = stateRef.current;
    if (acceptedEpoch.current === epoch.current.value && snapshot && snapshot.taskId === current.current.taskId && snapshot.threadId === current.current.threadId) {
      const key = roundKey(snapshot);
      suppressed.add(key);
      setSuppressedRound(key);
      if (suppressed.size > 100) suppressed.delete(suppressed.values().next().value!);
    } else {
      suppressBeforeRead.current = JSON.stringify([current.current.taskId, current.current.threadId]);
    }
  }, []);

  const key = state ? roundKey(state) : null;
  const suggestion = acceptedEpoch.current === epoch.current.value && eligible && state !== null && state.taskId === taskId && state.threadId === threadId
    && state.status === "complete" && key !== suppressedRound && !suppressed.has(key!)
    && validSuggestion(state.suggestion) ? state.suggestion : null;
  return { suggestion, state, suppress };
}
