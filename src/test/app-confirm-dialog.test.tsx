import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AppConfirmHost, appConfirm } from "../components/AppConfirmDialog";
import { I18nProvider } from "../i18n";

function renderHost() {
  return render(
    <I18nProvider>
      <AppConfirmHost />
    </I18nProvider>,
  );
}

/** 在 act 里发起确认，避免宿主状态更新脱离 act 包裹。 */
function openConfirm(message: string, options?: Parameters<typeof appConfirm>[1]) {
  let promise!: Promise<boolean>;
  act(() => {
    promise = appConfirm(message, options);
  });
  return promise;
}

describe("AppConfirmDialog", () => {
  beforeEach(() => {
    // jsdom 的 navigator.language 是 en-US；固定中文，断言默认按钮「确定 / 取消」。
    localStorage.setItem("nezha:language", "zh");
  });

  it("resolves true when the confirm button is clicked", async () => {
    renderHost();
    const user = userEvent.setup();

    const promise = openConfirm("确认删除任务 A？", { title: "删除任务" });
    expect(await screen.findByText("删除任务")).toBeInTheDocument();
    expect(screen.getByText("确认删除任务 A？")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确定" }));
    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when the cancel button is clicked", async () => {
    renderHost();
    const user = userEvent.setup();

    const promise = openConfirm("丢弃全部更改？", {
      title: "丢弃更改",
      okLabel: "丢弃",
      cancelLabel: "再想想",
    });
    expect(await screen.findByRole("button", { name: "丢弃" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "再想想" }));
    await expect(promise).resolves.toBe(false);
  });

  it("resolves false on Escape", async () => {
    renderHost();

    const promise = openConfirm("中断当前任务？", { title: "中断发送" });
    expect(await screen.findByText("中断发送")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(async () => {
      await expect(promise).resolves.toBe(false);
    });
  });

  it("keeps newlines in the message via the pre data flag", async () => {
    renderHost();

    openConfirm("第一行说明\n第二行说明", { title: "删除 PR" });
    const lead = await screen.findByText(/第一行说明/);
    expect(lead).toHaveAttribute("data-pre", "true");
    expect(lead.textContent).toContain("第二行说明");
  });

  it("cancels the previous pending confirm when a new one opens", async () => {
    renderHost();
    const user = userEvent.setup();

    const first = openConfirm("第一个确认", { title: "标题一" });
    const second = openConfirm("第二个确认", { title: "标题二" });

    await expect(first).resolves.toBe(false);
    expect(await screen.findByText("第二个确认")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确定" }));
    await expect(second).resolves.toBe(true);
  });
});
