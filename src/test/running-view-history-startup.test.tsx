import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RunningView } from "../components/RunningView";
import { I18nProvider } from "../i18n";
import type { ComponentProps } from "react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../components/TerminalView", () => ({ TerminalView: () => null }));
vi.mock("../components/SessionView", () => ({ SessionView: () => null }));
vi.mock("../components/codex-stream/CodexStreamView", () => ({ CodexStreamView: () => null }));
vi.mock("../components/Toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
afterEach(cleanup);

test("new running tasks wait for live frames; completed tasks still hydrate history", () => {
  const hydrate = vi.fn();
  const props: ComponentProps<typeof RunningView> = {
    task: { id: "new", projectId: "project", prompt: "hello", agent: "codex", runMode: "structured", permissionMode: "ask", status: "running", createdAt: 1, codexSessionPath: "C:/sessions/not-created-yet.jsonl" },
    projectPath: "C:/project", onCancel: vi.fn(), onReconnect: vi.fn(), onMarkDone: vi.fn(),
    onInput: vi.fn(), onResize: vi.fn(), onRegisterTerminal: () => 0, onTerminalReady: vi.fn(),
    onRename: vi.fn(), onGenerateName: async () => {}, themeVariant: "dark", terminalFontSize: 14,
    terminalScrollback: 5000, monoFontFamily: "monospace", onHydrateCodexHistory: hydrate,
    codexStream: { entries: [], usage: null, approval: null, userInput: null, history: { state: "idle" } },
  };
  const view = render(<I18nProvider><RunningView {...props} /></I18nProvider>);
  expect(hydrate).not.toHaveBeenCalled();
  view.rerender(<I18nProvider><RunningView {...props} task={{ ...props.task, status: "done" }} /></I18nProvider>);
  expect(hydrate).toHaveBeenCalledExactlyOnceWith(props.task.codexSessionPath);
});
