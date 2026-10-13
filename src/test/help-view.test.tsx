import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HelpView } from "../components/help/HelpView";
import { I18nProvider } from "../i18n";
import type { ThemeVariant } from "../types";

function renderHelp(themeVariant: ThemeVariant) {
  return render(
    <I18nProvider>
      <HelpView themeVariant={themeVariant} />
    </I18nProvider>,
  );
}

function frameOf(container: HTMLElement) {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("iframe not rendered");
  return frame;
}

describe("HelpView", () => {
  beforeEach(() => {
    localStorage.setItem("nezha:language", "zh");
  });

  it("embeds the manual with the active theme on first load", () => {
    const { container } = renderHelp("dark");
    expect(frameOf(container).getAttribute("src")).toBe(
      "help/operation-manual.html?embed=1&theme=dark",
    );
  });

  it("switches documents through the tab strip", async () => {
    const user = userEvent.setup();
    const { container } = renderHelp("light");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tb) => tb.textContent)).toEqual(["操作手册", "云效议题详解", "UI 盘问说明"]);
    await user.click(tabs[1]);

    expect(frameOf(container).getAttribute("src")).toBe(
      "help/yunxiao-launch-modes.html?embed=1&theme=light",
    );
  });

  it("opens the UI grill guide from its tab and via a cross-document link", async () => {
    const user = userEvent.setup();
    const { container } = renderHelp("light");

    // 第三个 tab 指向 UI 盘问说明
    await user.click(screen.getAllByRole("tab")[2]);
    expect(frameOf(container).getAttribute("src")).toBe(
      "help/grill-with-ui.html?embed=1&theme=light",
    );

    // 其他文档内的交叉链接（host 转发）也应能切到该文档
    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "nezha-help-open", file: "grill-with-ui.html" },
      }),
    );
    expect(frameOf(container).getAttribute("src")).toBe(
      "help/grill-with-ui.html?embed=1&theme=light",
    );
  });

  it("pushes theme changes via postMessage without reloading the frame", () => {
    const { container, rerender } = renderHelp("light");
    const frame = frameOf(container);
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    rerender(
      <I18nProvider>
        <HelpView themeVariant="midnight" />
      </I18nProvider>,
    );

    expect(postMessage).toHaveBeenLastCalledWith(
      { type: "nezha-help-theme", theme: "dark" },
      "*",
    );
    expect(frame.getAttribute("src")).toBe("help/operation-manual.html?embed=1&theme=light");
  });

  it("switches documents when the embedded doc posts a cross-document link", () => {
    const { container } = renderHelp("light");

    fireEvent(
      window,
      new MessageEvent("message", {
        data: { type: "nezha-help-open", file: "yunxiao-launch-modes.html" },
      }),
    );

    expect(frameOf(container).getAttribute("src")).toBe(
      "help/yunxiao-launch-modes.html?embed=1&theme=light",
    );
  });
});
