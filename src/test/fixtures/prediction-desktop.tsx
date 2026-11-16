/** Development-only acceptance entry. Real Tauri IPC, real CLI, real composer. */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { I18nProvider } from "../../i18n";
import { CodexComposer } from "../../components/codex-stream/CodexComposer";
import type { Project } from "../../types";
import "../../App.css";
import "../../styles/prediction-fixture.css";

type Entry = { at: number; task_id?: string; taskId?: string; status?: string; session_id?: string; session_path?: string; sourceTurnId?: string };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function geometry() {
  return Object.fromEntries([".nz-codexComposerBox", ".codex-prediction-input-wrap", ".nz-codexComposerFooter", ".codex-prediction-ghost", ".codex-prediction-tab", "textarea"].map(selector => {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    return [selector, rect ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null];
  }));
}
async function until<T>(read: () => T | Promise<T>, label: string, timeout = 15000): Promise<NonNullable<T>> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await read(); if (value) return value; await pause(5); }
  throw new Error(`Timed out: ${label}`);
}

function Fixture() {
  const [status, setStatus] = useState("Ready · isolated desktop fixture");
  const [identity, setIdentity] = useState<{task: string; thread: string}>();
  const [submissions, setSubmissions] = useState(0);
  const [locked, setLocked] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [timingOnly, setTimingOnly] = useState(true);
  const [allowNull, setAllowNull] = useState(false);
  const measurements = useRef<object[]>([]);
  useEffect(() => {
    void fetch("/acceptance-command.json").then(response => response.json()).then(async command => {
      if (!command.id || localStorage.getItem("acceptance-auto-last") === command.id) return;
      localStorage.setItem("acceptance-auto-last", command.id);
      if (command.action === "cold-chain") { await run("cold"); await globalSetting(); await run("one"); }
      if (command.action === "global-chain") { await globalSetting(); await run("one"); }
      if (command.action === "live") await run("live");
      if (command.action === "one") await run("one");
      if (command.action === "off") {
        await invoke("save_codex_prompt_predictions_enabled", {enabled: false});
        setStatus("Prediction disabled; retained sessions released");
      }
    }).catch(() => {}); // Optional fixture control file, absent during ordinary browser use.
    // Deliberate one-shot test runner; production components do not fetch this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function exportUi() {
    const project = (await invoke<Project[]>("load_projects")).find(p => p.id === "acceptance-project");
    if (project) await invoke("write_file_content", {projectPath: project.path, path: `${project.path}/ui-report.json`, content: JSON.stringify(measurements.current, null, 2)});
  }
  useEffect(() => {
    const measure = (event: Event) => {
      const started = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const input = document.querySelector("textarea");
        const rect = input?.getBoundingClientRect();
        measurements.current.push({event: event.type, trusted: event.isTrusted, inputType: (event as InputEvent).inputType,
          elapsedMs: performance.now() - started, valueLength: input?.value.length, caret: input?.selectionStart,
          height: rect?.height, width: rect?.width, ghost: !!document.querySelector(".codex-prediction-ghost"), geometry: geometry()});
      }));
    };
    document.addEventListener("input", measure);
    document.addEventListener("focusin", measure);
    document.addEventListener("click", measure);
    return () => { document.removeEventListener("input", measure); document.removeEventListener("focusin", measure); document.removeEventListener("click", measure); };
  }, []);
  async function globalSetting() {
    setLocked(true);
    try { setIdentity(await (await import("./prediction-desktop-scenarios")).verifyGlobalSetting(setStatus)); }
    catch (error) { setStatus(`FAIL: ${error}`); }
    finally { setLocked(false); }
  }
  async function run(kind: "warm" | "cold" | "one" | "live") {
    setLocked(true);
    const task = `acceptance-${kind}-${Date.now()}`;
    const statuses: Entry[] = [], predictions: Entry[] = [], sessions: Entry[] = [];
    const frames: {at: number; assistant: boolean; turnId?: string}[] = [], unexpected: string[] = [];
    const unlisten: (() => void)[] = [];
    const cycles: object[] = [];
    let project: Project | undefined;
    const report = {kind, task, timeOrigin: performance.timeOrigin, cycles, statuses, unexpected, error: ""};
    const save = async () => {
      if (project) await invoke("write_file_content", {projectPath: project.path, path: `${project.path}/${kind}-report.json`, content: JSON.stringify(report, null, 2)});
    };
    try {
      project = (await invoke<Project[]>("load_projects")).find(p => p.id === "acceptance-project");
      if (!project || !project.path.includes("prediction127-evidence")) throw new Error("Isolated fixture project is required");
      for (const name of ["task-status", "task-session", "codex-prompt-prediction", "codex-approval-requested", "codex-user-input-requested"]) {
        unlisten.push(await listen<Entry>(name, event => {
          const payload = event.payload;
          if ((payload.task_id || payload.taskId) !== task) return;
          const entry = {...payload, at: performance.now()};
          if (name === "task-status") statuses.push(entry);
          else if (name === "task-session") sessions.push(entry);
          else if (name === "codex-prompt-prediction") predictions.push(entry);
          else unexpected.push(name);
        }));
      }
      await invoke("save_codex_prompt_predictions_enabled", {enabled: kind !== "cold"});
      const count = kind === "one" || kind === "live" ? 1 : timingOnly ? 6 : kind === "warm" ? 30 : 21;
      for (let index = 0; index < count; index++) {
        const phase = index < 21 || index % 3 === 0 ? "returned" : index % 3 === 1 ? "during" : "before";
        const channel = new Channel<string>();
        channel.onmessage = data => { const frame = JSON.parse(data); frames.push({at: performance.now(),
          assistant: (frame.type === "agentMessageDelta" && !!frame.payload?.delta)
            || (frame.type === "item" && frame.payload?.type === "agentMessage" && !!frame.payload?.text), turnId: frame.turnId}); };
        const started = performance.now();
        const doneBefore = statuses.filter(s => s.status === "done").length;
        const args = {taskId: task, projectPath: project.path, permissionMode: "auto_edit", model: "gpt-6-astra",
          prompt: kind === "live" ? "List three checks for a next-message prediction feature. I will next ask you to turn those checks into an implementation plan. Do not use tools. Keep this reply brief."
            : `Acceptance ${kind} cycle ${index} phase=${phase}. Reply briefly without tools.`, onOutput: channel};
        setStatus(`${kind} ${index + 1}/${count}: starting`);
        if (index === 0) await invoke("run_task", {...args, taskName: "Prediction acceptance", realProjectPath: project.path,
          agent: "codex", runMode: "structured", reasoningEffort: "medium", requireSediment: false});
        else await invoke("resume_codex_structured", {...args, threadId: sessions[sessions.length - 1]?.session_id, effort: "medium"});
        const invokeReturned = performance.now();
        const done = await until(() => statuses.filter(s => s.status === "done")[doneBefore], "business completion");
        const thread = sessions[sessions.length - 1]?.session_id;
        if (!thread) throw new Error("No task-session event");
        setIdentity({task, thread});
        await pause(0);
        const pendingGeometry = geometry();
        if (kind !== "cold" && phase === "returned") {
          await until(() => predictions.find(p => p.status === "complete" && p.at >= done.at), "prediction completion");
        } else if (kind !== "cold" && phase === "during") {
          // The local provider holds this sample for 2s; resume while it is in flight.
          await pause(150);
        }
        const prediction = await invoke<{status: string; suggestion?: string; sessionGeneration: number} | null>("get_codex_prompt_prediction", {taskId: task, threadId: thread});
        const active = await invoke<string[]>("get_active_task_ids");
        if (unexpected.length || active.includes(task)) throw new Error("Auxiliary work emitted interaction or remained active");
        if (index < 21 && kind !== "cold" && kind !== "live" && !allowNull && !prediction?.suggestion) throw new Error("Eligible turn did not produce a suggestion");
        cycles.push({index, phase, started, invokeReturned, doneAt: done.at, firstOutputAt: frames.find(f => f.at >= started)?.at,
          firstAssistantAt: frames.find(f => f.at >= started && f.assistant)?.at,
          thread, sourceTurnId: predictions[predictions.length - 1]?.sourceTurnId, generation: prediction?.sessionGeneration,
          predictionStatus: prediction?.status, predictionAt: predictions[predictions.length - 1]?.at, frameCount: frames.length,
          pendingGeometry, completeGeometry: geometry()});
        setIdentity({task, thread});
        await save();
      }
      if (kind === "warm" || kind === "cold") await invoke("save_codex_prompt_predictions_enabled", {enabled: false});
      setStatus(`${kind}: PASS (${cycles.length} cycles)`);
    } catch (error) {
      report.error = String(error);
      setStatus(`FAIL: ${error}`);
    } finally {
      try { await save(); } finally { unlisten.forEach(stop => stop()); setLocked(false); }
    }
  }
  return <main className="prediction-fixture" data-width={narrow ? "narrow" : "wide"}>
    <h1>Nezha desktop · synthetic acceptance</h1><p>{status}</p>
    <nav><button disabled={locked} onClick={() => void run("warm")}>Run warm</button><button disabled={locked} onClick={() => void run("cold")}>Run cold</button><button disabled={locked} onClick={() => void run("one")}>New suggestion</button></nav>
    <nav><button onClick={() => document.documentElement.classList.remove("dark")}>Light</button><button onClick={() => document.documentElement.classList.add("dark")}>Dark</button><button onClick={() => setNarrow(!narrow)}>Width</button><button onClick={() => setDisabled(!disabled)}>Disabled</button></nav>
    <nav><label><input type="checkbox" checked={timingOnly} onChange={event => setTimingOnly(event.target.checked)} />Timing subset (6 cycles)</label><button onClick={() => void exportUi()}>Export UI metrics</button></nav>
    <nav><button disabled={locked} onClick={() => void globalSetting()}>Global settings</button><button disabled={locked} onClick={() => void run("live")}>Live smoke</button><label><input type="checkbox" checked={allowNull} onChange={event => setAllowNull(event.target.checked)} />Allow null</label></nav>
    {identity && <CodexComposer key={identity.task} taskId={identity.task} threadId={identity.thread} predictionEligible disabled={disabled}
      mode="resume" onSubmit={() => setSubmissions(n => n + 1)} showModelBadge model="gpt-6-astra" onSetModel={() => {}} />}
    <output>Submissions: {submissions}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider><Fixture /></I18nProvider>);
