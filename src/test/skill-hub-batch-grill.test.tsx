import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../components/app-settings/SkillsPanel";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../components/app-settings/types";
import { I18nProvider } from "../i18n";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

/** load_app_settings / get_skill_hub_config 之外一律返回 null。 */
function mockBackend(settings: Partial<AppSettings>) {
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "load_app_settings") {
      return Promise.resolve({ ...DEFAULT_APP_SETTINGS, ...settings });
    }
    if (cmd === "get_skill_hub_config") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

function renderPanel() {
  return render(
    <I18nProvider>
      <SkillsPanel />
    </I18nProvider>,
  );
}

describe("SkillsPanel batch grill (experimental skill)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders the toggle off with the experimental badge by default", async () => {
    mockBackend({});
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Batch Grill" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Experimental")).toBeInTheDocument();
  });

  it("reflects an enabled setting and persists the flip", async () => {
    mockBackend({ batch_grill_enabled: true });
    const user = userEvent.setup();
    renderPanel();

    const toggle = await screen.findByRole("switch", { name: "Batch Grill" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "save_batch_grill_enabled") {
        return Promise.resolve({ ...DEFAULT_APP_SETTINGS, batch_grill_enabled: false });
      }
      return Promise.resolve(null);
    });
    await user.click(toggle);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("save_batch_grill_enabled", { enabled: false }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });
});
