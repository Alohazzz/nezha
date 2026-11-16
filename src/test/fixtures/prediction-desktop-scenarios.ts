import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Project } from "../../types";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function wait(read: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) { if (await read()) return; await pause(10); }
  throw new Error(`Timed out: ${label}`);
}

/** Public command boundary: a global setting invalidates task B while task C runs. */
export async function verifyGlobalSetting(status: (text: string) => void) {
  const project = (await invoke<Project[]>("load_projects")).find(p => p.id === "acceptance-project");
  if (!project || !project.path.includes("prediction127-evidence")) throw new Error("Isolated fixture required");
  const tasks = ["a", "b", "c"].map(suffix => `global-${Date.now()}-${suffix}`);
  const threads = new Map<string, string>();
  const done = new Set<string>();
  const stopSession = await listen<{task_id: string; session_id: string}>("task-session", event => {
    if (tasks.includes(event.payload.task_id)) threads.set(event.payload.task_id, event.payload.session_id);
  });
  const stopStatus = await listen<{task_id: string; status: string}>("task-status", event => {
    if (tasks.includes(event.payload.task_id) && event.payload.status === "done") done.add(event.payload.task_id);
  });
  const prediction = (task: string) => invoke<{status: string; suggestion?: string} | null>("get_codex_prompt_prediction", {taskId: task, threadId: threads.get(task)});
  const report = {bothCached: false, bothInvalidated: false, runningPreserved: false, runningCompleted: false, error: ""};
  try {
    await invoke("save_codex_prompt_predictions_enabled", {enabled: true});
    for (const task of tasks) {
      status(`Global settings: starting ${task.slice(-1)}`);
      await invoke("run_task", {taskId: task, taskName: "Global setting fixture", projectPath: project.path, realProjectPath: project.path,
        permissionMode: "auto_edit", model: "gpt-6-astra", reasoningEffort: "medium", agent: "codex", runMode: "structured",
        prompt: "Synthetic global-setting acceptance. Reply briefly without tools.", onOutput: new Channel<string>(), requireSediment: false});
      if (task !== tasks[2]) await wait(async () => done.has(task) && !!(await prediction(task))?.suggestion, "cached suggestion");
    }
    report.bothCached = !!(await prediction(tasks[0]))?.suggestion && !!(await prediction(tasks[1]))?.suggestion;
    await invoke("save_codex_structured_model", {model: "gpt-6-astra", effort: "low"});
    const invalidated = await Promise.all([prediction(tasks[0]), prediction(tasks[1])]);
    report.bothInvalidated = invalidated.every(result => !result || (result.status === "invalidated" && !result.suggestion));
    report.runningPreserved = (await invoke<string[]>("get_active_task_ids")).includes(tasks[2]);
    await wait(() => done.has(tasks[2]), "running user turn completes");
    report.runningCompleted = true;
    if (!Object.values(report).slice(0, 4).every(Boolean)) throw new Error("Global invalidation invariant failed");
    status("Global settings: PASS (A/B invalidated; running C preserved)");
    return {task: tasks[1], thread: threads.get(tasks[1])!};
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    await invoke("save_codex_prompt_predictions_enabled", {enabled: false});
    await invoke("save_codex_structured_model", {model: null, effort: null});
    await invoke("write_file_content", {projectPath: project.path, path: `${project.path}/global-report.json`, content: JSON.stringify(report, null, 2)});
    stopSession(); stopStatus();
  }
}
