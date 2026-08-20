import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { FileMentionField } from "../components/yunxiao/FileMention";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const FILES = ["src/App.tsx", "src/utils/yunxiao.ts", "docs/readme.md"];

// FileMentionField 是受控组件：用 stateful Harness 驱动 value 回写。
function Harness({ projectPath = "proj-a" }: { projectPath?: string }) {
  const [value, setValue] = useState("");
  return (
    <I18nProvider>
      <FileMentionField
        as="textarea"
        projectPath={projectPath}
        value={value}
        onChange={setValue}
      />
    </I18nProvider>
  );
}

describe("云效补充表单 @ 文件引用", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_project_files") return Promise.resolve(FILES);
      return Promise.resolve(null);
    });
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("输入 @ 弹出当前项目文件候选", async () => {
    const user = userEvent.setup();
    render(<Harness projectPath="proj-open" />);
    await user.type(screen.getByRole("textbox"), "@");
    await screen.findByText("App.tsx");
    expect(screen.getByText("yunxiao.ts")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("list_project_files", {
      projectPath: "proj-open",
    });
  });

  it("按 query 过滤候选", async () => {
    const user = userEvent.setup();
    render(<Harness projectPath="proj-filter" />);
    await user.type(screen.getByRole("textbox"), "@utils");
    await screen.findByText("yunxiao.ts");
    expect(screen.queryByText("App.tsx")).toBeNull();
  });

  it("点击选中插入 @相对路径 并关闭浮层", async () => {
    const user = userEvent.setup();
    render(<Harness projectPath="proj-insert" />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "@App");
    await screen.findByText("App.tsx");
    await user.click(screen.getByText("App.tsx"));
    await waitFor(() => expect(textarea).toHaveValue("@src/App.tsx"));
    expect(screen.queryByText("yunxiao.ts")).toBeNull();
  });

  it("键盘 Enter 选中当前高亮项", async () => {
    const user = userEvent.setup();
    render(<Harness projectPath="proj-keyboard" />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "@yunxiao");
    await screen.findByText("yunxiao.ts");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(textarea).toHaveValue("@src/utils/yunxiao.ts"));
  });

  it("query 含空格时关闭浮层", async () => {
    const user = userEvent.setup();
    render(<Harness projectPath="proj-space" />);
    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "@App");
    await screen.findByText("App.tsx");
    await user.type(textarea, " ");
    await waitFor(() => expect(screen.queryByText("App.tsx")).toBeNull());
  });
});
