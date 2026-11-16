import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MergeHubView } from "../components/codeup/MergeHubView";
import type { CodeupMr } from "../types";
const { invoke, confirm, save } = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  save: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));
vi.mock("../components/AppConfirmDialog", () => ({ appConfirm: confirm }));
vi.mock("../components/mermaid/MessageMarkdownBody", () => ({
  MessageMarkdownBody: ({ text }: { text: string }) => <div>{text}</div>,
}));
const mr: CodeupMr = {
  id: "biz-unique",
  repositoryId: "123",
  localId: 42,
  repository: "team/demo",
  title: "修复会话状态",
  sourceBranch: "fix/session",
  targetBranch: "main",
  status: "TO_BE_MERGED",
  author: "测试作者",
  reviewers: ["审核人"],
  pulled: true,
  worktreePath: "/demo",
  projectId: "p",
  projectPath: "/demo",
  description: "",
  detailUrl: "",
  createdAt: 0,
  updatedAt: 0,
  hasConflict: false,
};
const start = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  return render(<MergeHubView onBack={vi.fn()} onStartCodeupTask={start} />);
}
async function openClose() {
  fireEvent.click(await screen.findByRole("button", { name: "关闭请求" }));
  return screen.getByRole("dialog");
}
beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "codeup_list_repositories") return [];
    if (cmd === "codeup_list_pending_mrs")
      return args.state === "closed" ? [{ ...mr, status: "CLOSED" }] : [mr];
    if (cmd === "codeup_read_review") return [];
    if (cmd === "codeup_read_review_report") return "# 原始审查报告";
    return undefined;
  });
});
afterEach(cleanup);
describe("merge hub B layout", () => {
  it("requires explicit confirmation and sends repository ID plus local ID", async () => {
    setup();
    const dialog = await openClose();
    expect(within(dialog).getByText("team/demo #42")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "暂不关闭" }));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "codeup_close_mr")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "关闭请求" }));
    fireEvent.click(screen.getByRole("button", { name: "确认关闭请求" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("codeup_close_mr", { repositoryId: "123", mrId: "42" });
    expect(screen.queryByRole("button", { name: "关闭请求" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "已关闭" }));
    await waitFor(() =>
      expect(screen.getByRole("article", { name: "合并请求详情" })).toHaveTextContent("已关闭"),
    );
    expect(invoke).toHaveBeenCalledWith("codeup_list_pending_mrs", {
      repositoryId: null,
      state: "closed",
    });
    expect(screen.queryByRole("button", { name: "分支合并" })).not.toBeInTheDocument();
  });
  it("retains the request and allows retry after permission failure", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd, args) =>
      cmd === "codeup_close_mr" ? Promise.reject(new Error("HTTP 403: 无权限")) : base(cmd, args),
    );
    setup();
    await openClose();
    fireEvent.click(screen.getByRole("button", { name: "确认关闭请求" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("403");
    expect(screen.getByRole("button", { name: "确认关闭请求" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "暂不关闭" }));
    expect(screen.getByRole("article", { name: "合并请求详情" })).toHaveTextContent(mr.title);
  });
  it("blocks duplicate submission and dismissal while closing", async () => {
    const pending = deferred<void>();
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd, args) =>
      cmd === "codeup_close_mr" ? pending.promise : base(cmd, args),
    );
    setup();
    await openClose();
    fireEvent.click(screen.getByRole("button", { name: "确认关闭请求" }));
    expect(screen.getByRole("button", { name: "正在关闭…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "暂不关闭" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "codeup_close_mr")).toHaveLength(1);
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("discards an outdated list response after changing status", async () => {
    const pending = deferred<CodeupMr[]>();
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd, args) =>
      cmd === "codeup_list_pending_mrs" && args.state === "opened"
        ? pending.promise
        : base(cmd, args),
    );
    setup();
    fireEvent.click(screen.getByRole("button", { name: "已关闭" }));
    await screen.findByRole("article", { name: "合并请求详情" });
    await act(async () => pending.resolve([mr]));
    expect(screen.getByRole("article", { name: "合并请求详情" })).toHaveTextContent("已关闭");
    expect(screen.queryByRole("button", { name: "关闭请求" })).not.toBeInTheDocument();
  });
  it("preserves conflict merge and fail-findings confirmation", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation((cmd, args) =>
      cmd === "codeup_list_pending_mrs"
        ? Promise.resolve([{ ...mr, hasConflict: true }])
        : cmd === "codeup_read_review"
          ? Promise.resolve([{ rule: "blocking", status: "fail" }])
          : base(cmd, args),
    );
    confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "分支合并" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "分支合并" })).toBeEnabled());
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "分支合并" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ id: mr.id }), "merge"),
    );
  });
  it("publishes the edited report to the selected repository and local ID", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "审查报告" }));
    await screen.findByText("# 原始审查报告");
    fireEvent.click(screen.getByRole("button", { name: "回写到评论" }));
    fireEvent.change(screen.getByRole("textbox", { name: "回写评论内容" }), {
      target: { value: "  修改后的报告  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布评论" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("codeup_create_mr_comment", {
        repositoryId: "123",
        mrId: "42",
        content: "修改后的报告",
      }),
    );
    expect(await screen.findByText("审查报告已回写到云效合并请求评论。")).toBeInTheDocument();
  });
});
