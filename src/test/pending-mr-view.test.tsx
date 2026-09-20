import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { PendingBranchCandidate, PendingBranchRepoScan, Project } from "../types";
import { PendingMrView } from "../components/codeup/PendingMrView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  Channel: class {},
}));

function candidate(overrides: Partial<PendingBranchCandidate> = {}): PendingBranchCandidate {
  return {
    branch: "fix/v2.20260901/develop/QHDK-30395-x",
    repo: "HIS",
    repoPath: "/workspace/HIS",
    pushed: true,
    protected: false,
    protectedSource: "platform",
    unmerged: 3,
    mergeState: "unmerged",
    mergedInto: null,
    targetBranch: "develop",
    targetSource: "name",
    mine: true,
    authors: ["me@test.test"],
    lastCommitAuthor: "苏一",
    lastCommitAt: 1_700_000_000,
    additions: 248,
    deletions: 31,
    openMrId: null,
    openMrState: "",
    openMrConflict: false,
    deletable: false,
    skipReason: "未完成合并进 develop，不可删除",
    dataMissing: false,
    ...overrides,
  };
}

function scan(branches: PendingBranchCandidate[], overrides: Partial<PendingBranchRepoScan> = {}): PendingBranchRepoScan {
  return {
    name: "HIS",
    path: "/workspace/HIS",
    ok: true,
    message: "",
    platformOk: true,
    mrOk: true,
    branches,
    ...overrides,
  };
}

const projects: Project[] = [
  { id: "p1", name: "HIS", path: "/workspace/HIS" } as Project,
];

/** 只 mock list_branch_pr_candidates；prune 结果按 dryRun 分别返回。 */
function mockList(scanResult: PendingBranchRepoScan[], prune?: (dryRun: boolean) => unknown) {
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "list_branch_pr_candidates") return Promise.resolve(scanResult);
    if (command === "prune_remote_branches") {
      return Promise.resolve(prune ? prune(Boolean(args?.dryRun)) : []);
    }
    return Promise.resolve(null);
  });
}

const renderView = () =>
  render(<PendingMrView projects={projects} onBack={() => {}} />);

describe("PendingMrView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("shows a candidate card with merge state, my badge and target inference source", async () => {
    mockList([scan([candidate()])]);
    renderView();

    expect(await screen.findByText("fix/v2.20260901/develop/QHDK-30395-x")).toBeInTheDocument();
    expect(screen.getByText("未合并")).toBeInTheDocument();
    expect(screen.getByText("无 MR")).toBeInTheDocument();
    expect(screen.getByText("我的提交")).toBeInTheDocument();
    expect(screen.getByText("（按分支名推断）")).toBeInTheDocument();
    expect(screen.getByText("+248")).toBeInTheDocument();
  });

  it("shows an explicit empty state when nothing is pending", async () => {
    mockList([scan([])]);
    renderView();
    expect(await screen.findByText(/当前筛选下没有待发起的分支/)).toBeInTheDocument();
  });

  it("surfaces a credential/network failure instead of an empty list", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_branch_pr_candidates") {
        return Promise.reject("云效个人访问令牌不能为空（请在应用设置中配置）");
      }
      return Promise.resolve(null);
    });
    renderView();
    expect(await screen.findByText(/云效个人访问令牌不能为空/)).toBeInTheDocument();
  });

  it("marks MR state unknown when platform MR data is unavailable", async () => {
    mockList([scan([candidate()], { mrOk: false })]);
    renderView();
    expect(await screen.findByText(/云效 MR 数据不可用/)).toBeInTheDocument();
    expect(screen.getByText("MR 未知")).toBeInTheDocument();
  });

  it("hides other people's branches when mine-only is on, and restores them when off", async () => {
    mockList([
      scan([
        candidate({ branch: "mine/develop/x", mine: true }),
        candidate({ branch: "colleague/develop/y", mine: false }),
      ]),
    ]);
    renderView();

    expect(await screen.findByText("mine/develop/x")).toBeInTheDocument();
    expect(screen.queryByText("colleague/develop/y")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /我的提交/ }));
    expect(await screen.findByText("colleague/develop/y")).toBeInTheDocument();
  });

  it("filters by branch-name search", async () => {
    mockList([
      scan([
        candidate({ branch: "alpha/develop/x" }),
        candidate({ branch: "beta/develop/y" }),
      ]),
    ]);
    renderView();
    await screen.findByText("alpha/develop/x");

    fireEvent.change(screen.getByPlaceholderText("搜索分支…"), { target: { value: "beta" } });
    expect(screen.queryByText("alpha/develop/x")).not.toBeInTheDocument();
    expect(screen.getByText("beta/develop/y")).toBeInTheDocument();
  });

  it("disables the delete action until a deletable branch is selected", async () => {
    mockList([
      scan([
        candidate({ branch: "merged/v2/develop/QHDK-9", unmerged: 0, mergeState: "merged", mergedInto: "develop", deletable: true }),
        candidate({ branch: "wip/develop/QHDK-8" }),
      ]),
    ]);
    renderView();
    await screen.findByText("merged/v2/develop/QHDK-9");

    const deleteBtn = screen.getByRole("button", { name: /删除远端分支/ });
    expect(deleteBtn).toBeDisabled();

    // 选不可删的分支仍然禁用
    fireEvent.click(screen.getByLabelText("wip/develop/QHDK-8"));
    expect(screen.getByRole("button", { name: /删除远端分支/ })).toBeDisabled();

    // 选可删的分支后启用，并显示计数
    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    expect(screen.getByRole("button", { name: /删除远端分支/ })).toBeEnabled();
  });

  it("runs the dry-run scan, confirms in an in-app dialog, then deletes", async () => {
    mockList(
      [
        scan([
          candidate({ branch: "merged/v2/develop/QHDK-9", unmerged: 0, mergeState: "merged", mergedInto: "develop", deletable: true }),
        ]),
      ],
      (dryRun) =>
        dryRun
          ? [
              {
                repo: "HIS",
                repoPath: "/workspace/HIS",
                branch: "merged/v2/develop/QHDK-9",
                targetBranch: "develop",
                deleted: false,
                deletable: true,
                reason: "已完整合入 origin/develop",
              },
            ]
          : [
              {
                repo: "HIS",
                repoPath: "/workspace/HIS",
                branch: "merged/v2/develop/QHDK-9",
                targetBranch: "develop",
                deleted: true,
                deletable: true,
                reason: "已删除远端分支（已完整合入 origin/develop）",
              },
            ],
    );
    renderView();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));

    // 先 dry-run 扫描
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("prune_remote_branches", {
        projectPath: "/workspace/HIS",
        items: [
          {
            repoPath: "/workspace/HIS",
            repo: "HIS",
            branch: "merged/v2/develop/QHDK-9",
            targetBranch: "develop",
          },
        ],
        dryRun: true,
      });
    });

    // 确认框列出分支名与目标分支；此时尚未真删
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("merged/v2/develop/QHDK-9");
    expect(dialog.textContent).toContain("目标分支 develop");
    expect(
      invokeMock.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "prune_remote_branches" && (args as { dryRun?: boolean }).dryRun === false,
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /删除 1 个远端分支/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("prune_remote_branches", {
        projectPath: "/workspace/HIS",
        items: [
          {
            repoPath: "/workspace/HIS",
            repo: "HIS",
            branch: "merged/v2/develop/QHDK-9",
            targetBranch: "develop",
          },
        ],
        dryRun: false,
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/✓ 已删除 HIS:merged\/v2\/develop\/QHDK-9/)).toBeInTheDocument();
  });

  it("does not ask for confirmation when nothing passes the delete gate", async () => {
    mockList(
      [
        scan([
          candidate({ branch: "merged/v2/develop/QHDK-9", unmerged: 0, mergeState: "merged", mergedInto: "develop", deletable: true }),
        ]),
      ],
      () => [
        {
          repo: "HIS",
          repoPath: "/workspace/HIS",
          branch: "merged/v2/develop/QHDK-9",
          targetBranch: "develop",
          deleted: false,
          deletable: false,
          reason: "未完成合并进 develop，已拒绝删除",
        },
      ],
    );
    renderView();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));

    expect(await screen.findByText(/所选分支均不满足删除条件/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "prune_remote_branches"),
    ).toHaveLength(1);
  });

  it("persists the my-commits toggle across mounts", async () => {
    // 默认开启「我的提交」：非我的分支被隐藏，且开关处于激活态。
    mockList([scan([candidate({ branch: "mine/develop/x", mine: false })])]);
    const first = renderView();
    expect(await screen.findByText(/当前筛选下没有待发起的分支/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /我的提交/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 关掉后写入 localStorage，非我的分支出现
    fireEvent.click(screen.getByRole("button", { name: /我的提交/ }));
    expect(await screen.findByText("mine/develop/x")).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("nezha.pendingMr.mineOnly")).toBe("false"));
    first.unmount();

    // 重新挂载后记住了「关闭」：非我的分支直接可见
    mockList([scan([candidate({ branch: "mine/develop/x", mine: false })])]);
    renderView();
    expect(await screen.findByText("mine/develop/x")).toBeInTheDocument();
  });
});
