import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CodexComposer } from "../components/codex-stream/CodexComposer";
import type { ComponentProps } from "react";
import { I18nProvider } from "../i18n";
const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
let sequence = 0;
beforeEach(() => {
  bridge.listen.mockResolvedValue(() => {});
  bridge.invoke.mockImplementation(async (command, args) => command === "get_codex_prompt_prediction" ? {
    taskId: args.taskId, threadId: "thread", sourceTurnId: "turn", sessionGeneration: 1,
    revision: 1, status: "complete", suggestion: "Run the tests.",
  } : []);
  document.execCommand = vi.fn((_command, _ui, value) => {
    const input = document.activeElement as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value } });
    return true;
  });
});
afterEach(cleanup);
async function mount(props: Partial<ComponentProps<typeof CodexComposer>> = {}) {
  const onSubmit = vi.fn();
  render(<I18nProvider><CodexComposer taskId={`composer-${++sequence}`} threadId="thread" predictionEligible mode="resume" onSubmit={onSubmit} {...props} /></I18nProvider>);
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(document.querySelector(".codex-prediction-ghost")).toHaveTextContent("Run the tests."));
  return { input, onSubmit };
}
test("focused bare Tab accepts a readable suggestion as a draft without submitting", async () => {
  const { input, onSubmit } = await mount();
  act(() => input.focus());
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(false);
  expect(input).toHaveValue("Run the tests.");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
});
test.each([{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }])("modified or IME Tab remains native: %j", async (modifiers) => {
  const { input } = await mount();
  act(() => input.focus());
  expect(fireEvent.keyDown(input, { key: "Tab", ...modifiers })).toBe(true);
  expect(input).toHaveValue("");
  expect(document.execCommand).not.toHaveBeenCalled();
});
test("suggestion describes the textarea without a live announcement; hint requires focus", async () => {
  const { input } = await mount();
  expect(input).toHaveAccessibleDescription(/Run the tests/);
  expect(input).toHaveAccessibleName();
  expect(document.querySelector(".codex-prediction-tab")).toBeNull();
  act(() => input.focus());
  expect(document.querySelector(".codex-prediction-tab")).not.toBeNull();
  expect(document.querySelector("[aria-live]")).toBeNull();
  fireEvent.blur(input);
  expect(document.querySelector(".codex-prediction-tab")).toBeNull();
});
test("typing then clearing, paste, and composition do not restore the same suggestion", async () => {
  const { input } = await mount();
  fireEvent.change(input, { target: { value: "my draft" } });
  fireEvent.change(input, { target: { value: "" } });
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
});
test("composition suppresses suggestions before the first committed character", async () => {
  const { input, onSubmit } = await mount();
  fireEvent.compositionStart(input);
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
  fireEvent.compositionEnd(input);
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});
test("legacy IME keyCode 229 hides the ghost without requiring compositionStart", async () => {
  const { input, onSubmit } = await mount();
  act(() => input.focus());
  fireEvent.keyDown(input, { key: "Process", keyCode: 229 });
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
  expect(input).toHaveValue("");
  expect(onSubmit).not.toHaveBeenCalled();
});
test("pasting an image suppresses immediately and removing it does not restore prediction", async () => {
  const { input } = await mount();
  fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => new File(["image"], "test.png", { type: "image/png" }) }] } });
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
  await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("img").parentElement!.querySelector("button")!);
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
});
test("accepted draft submits only after an explicit Enter, and Enter without draft never accepts", async () => {
  const { input, onSubmit } = await mount();
  act(() => input.focus());
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveValue("");
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Tab" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Run the tests.", []);
});
test("opening the model menu excludes prediction acceptance even if textarea regains focus", async () => {
  const { input } = await mount({ showModelBadge: true, onSetModel: vi.fn(), model: "synthetic-model" });
  fireEvent.click(screen.getByText("synthetic-model"));
  act(() => input.focus());
  expect(document.querySelector(".codex-prediction-ghost")).toBeNull();
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(document.execCommand).not.toHaveBeenCalled();
});
test("unfocused Tab cannot accept a visible suggestion", async () => {
  const { input } = await mount();
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(document.execCommand).not.toHaveBeenCalled();
});
