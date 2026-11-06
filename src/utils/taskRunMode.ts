import type { AgentType, TaskRunMode } from "../types";

/** Snapshot the global setting for every newly created task; legacy tasks keep their mode. */
export function resolveTaskRunMode(
  agent: AgentType,
  configured: TaskRunMode,
): TaskRunMode | undefined {
  return agent === "codex" && configured === "structured" ? "structured" : undefined;
}
