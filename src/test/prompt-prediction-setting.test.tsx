import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PromptPredictionSetting } from "../components/app-settings/PromptPredictionSetting";
import { DEFAULT_APP_SETTINGS, APP_SETTINGS_CHANGED_EVENT } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));

test("explicit opt-in is persisted and announces settings changes; failed saves retain the checked value", async () => {
  bridge.invoke.mockResolvedValueOnce(DEFAULT_APP_SETTINGS);
  render(<I18nProvider><PromptPredictionSetting /></I18nProvider>);
  const toggle = screen.getByRole("switch");
  await waitFor(() => expect(toggle).toBeEnabled());
  expect(toggle).toHaveAttribute("aria-checked", "false");
  const changed = vi.fn();
  window.addEventListener(APP_SETTINGS_CHANGED_EVENT, changed);
  bridge.invoke.mockResolvedValueOnce({ ...DEFAULT_APP_SETTINGS, codex_prompt_predictions_enabled: true });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(bridge.invoke).toHaveBeenLastCalledWith("save_codex_prompt_predictions_enabled", { enabled: true });
  expect(changed).toHaveBeenCalledOnce();
  bridge.invoke.mockRejectedValueOnce(new Error("save failed"));
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle).toHaveAttribute("aria-checked", "true");
  window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, changed);
});
