import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { CodexApprovalRequest, CodexServerRequestResolved } from "../types";

/** Keep every unanswered request; the UI displays the oldest one per task. */
export function useCodexApprovalQueue(
  onChange: (taskId: string, approval: CodexApprovalRequest | null) => void,
) {
  const queues = useRef(new Map<string, CodexApprovalRequest[]>());
  const [visible, setVisible] = useState<Record<string, CodexApprovalRequest>>({});

  const publish = useCallback((taskId: string, queue: CodexApprovalRequest[]) => {
    const head = queue[0] ?? null;
    onChange(taskId, head);
    setVisible((prev) => {
      if ((prev[taskId] ?? null) === head) return prev;
      const next = { ...prev };
      if (head) next[taskId] = head;
      else delete next[taskId];
      return next;
    });
  }, [onChange]);

  useEffect(() => {
    let mounted = true;
    const listener = listen<CodexApprovalRequest>("codex-approval-requested", ({ payload }) => {
      if (!mounted || !payload?.task_id) return;
      const taskId = payload.task_id;
      const queue = queues.current.get(taskId) ?? [];
      if (queue.some((item) => item.request_id === payload.request_id
        && item.threadId === payload.threadId && item.turnId === payload.turnId)) return;
      const next = [...queue, payload];
      queues.current.set(taskId, next);
      publish(taskId, next);
    });
    return () => { mounted = false; void listener.then((unlisten) => unlisten()); };
  }, [publish]);

  // Capture the rendered request, not the queue head at response-completion time.
  // A late/duplicate callback must not dismiss a newer request or replacement session.
  const resolve = useCallback((taskId: string) => {
    const request = visible[taskId];
    const queue = queues.current.get(taskId);
    if (!request || !queue?.includes(request)) return;
    const next = queue.filter((item) => item !== request);
    if (next.length) queues.current.set(taskId, next);
    else queues.current.delete(taskId);
    publish(taskId, next);
  }, [visible, publish]);

  const clear = useCallback((taskId: string) => {
    queues.current.delete(taskId);
    publish(taskId, []);
  }, [publish]);

  const resolveFromServer = useCallback((event: CodexServerRequestResolved) => {
    const queue = queues.current.get(event.task_id);
    if (!queue) return;
    const next = queue.filter((request) => request.threadId !== event.threadId
      || request.request_id !== event.requestId);
    if (next.length === queue.length) return;
    if (next.length) queues.current.set(event.task_id, next);
    else queues.current.delete(event.task_id);
    publish(event.task_id, next);
  }, [publish]);

  return { resolve, clear, resolveFromServer };
}
