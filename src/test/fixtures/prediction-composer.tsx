/** Browser-only synthetic fixture. Run Vite and open /src/test/fixtures/prediction-composer.html. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { I18nProvider } from "../../i18n";
import { CodexComposer } from "../../components/codex-stream/CodexComposer";
import "../../App.css";
import "../../styles/prediction-fixture.css";
const query = new URLSearchParams(location.search);
mockIPC((command, args) => command === "get_codex_prompt_prediction" && !query.has("off") ? {
  taskId: (args as { taskId: string }).taskId, threadId: "fixture-thread", sourceTurnId: "fixture-turn",
  sessionGeneration: 1, revision: 1, status: "complete",
  suggestion: "Run the focused tests, inspect the resulting diff, and summarize any remaining verification gaps before continuing.",
} : [], { shouldMockEvents: true });
function Fixture() {
  const [round, setRound] = useState(1);
  const [submissions, setSubmissions] = useState(0);
  return <main className="prediction-fixture">
    <h1>Browser fixture · synthetic data</h1>
    <p>Completed Codex turn — next message suggestion</p>
    <nav><button onClick={() => setRound(round + 1)}>New round</button><button onClick={() => { document.documentElement.classList.remove("dark"); }}>Light</button><button onClick={() => { document.documentElement.classList.add("dark"); }}>Dark</button></nav>
    <CodexComposer key={round} taskId={`fixture-${round}`} threadId="fixture-thread" predictionEligible mode="resume" showModelBadge={query.has("models")} model="gpt-6-astra" reasoningEffort="medium" onSetModel={() => {}} onSubmit={() => setSubmissions(submissions + 1)} />
    <output>Submissions: {submissions}</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<I18nProvider><Fixture /></I18nProvider>);
