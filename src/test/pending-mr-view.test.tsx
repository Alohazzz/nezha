import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom";
import type { PendingBranchCandidate, PendingBranchRepoScan, Project } from "../types";
import { PendingMrView } from "../components/codeup/PendingMrView";

// jsdom 缺 Radix Select 打开下拉时会调用的 pointer-capture / scrollIntoView API。
// 与 task-model-selector / light-model-section 等既有测试同样在文件内补桩。
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

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

/**
 * mock 两段加载：`list_branch_pr_repos` 秒回仓库下拉，`list_branch_pr_candidates` 只在选中
 * 仓库后才被调用。prune 结果按 dryRun 分别返回。
 */
function mockList(scanResult: PendingBranchRepoScan[], prune?: (dryRun: boolean) => unknown) {
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    if (command === "list_branch_pr_repos") {
      return Promise.resolve([{ name: "HIS", path: "/workspace/HIS" }]);
    }
    if (command === "list_branch_pr_candidates") return Promise.resolve(scanResult);
    if (command === "prune_remote_branches") {
      return Promise.resolve(prune ? prune(Boolean(args?.dryRun)) : []);
    }
    return Promise.resolve(null);
  });
}

/** 挂载视图并选中 HIS 仓库（分段加载的第二步）。 */
async function renderAndSelectRepo() {
  const view = render(<PendingMrView projects={projects} onBack={() => {}} />);
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("list_branch_pr_repos", {
      projectPath: "/workspace/HIS",
    }),
  );
  const repoSelect = await screen.findByRole("combobox", { name: /全部仓库/ });
  fireEvent.click(repoSelect);
  fireEvent.click(await screen.findByRole("option", { name: "HIS" }));
  return view;
}

describe("PendingMrView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("shows a candidate card with merge state, my badge and target inference source", async () => {
    mockList([scan([candidate()])]);
    await renderAndSelectRepo();

    expect(await screen.findByText("fix/v2.20260901/develop/QHDK-30395-x")).toBeInTheDocument();
    expect(screen.getByText("未合并")).toBeInTheDocument();
    expect(screen.getByText("无 MR")).toBeInTheDocument();
    // 「我的提交」在工具条开关与卡片徽标上都有，这里断言徽标本身。
    const badgeTexts = [...document.querySelectorAll(".pm-badge")].map((b) => b.textContent);
    expect(badgeTexts).toContain("我的提交");
    expect(screen.getByText("按分支名推断")).toBeInTheDocument();
    expect(screen.getByText("+248")).toBeInTheDocument();
  });

  it("shows an explicit empty state when nothing is pending", async () => {
    mockList([scan([])]);
    await renderAndSelectRepo();
    expect(await screen.findByText(/当前筛选下没有发起合并的分支/)).toBeInTheDocument();
  });

  it("loads repos first and only scans branches after a repo is picked", async () => {
    // 分段加载的核心契约：未选仓库时不得调用分支扫描（那是几十秒的开销）。
    mockList([scan([candidate()])]);
    render(<PendingMrView projects={projects} onBack={() => {}} />);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_branch_pr_repos", {
        projectPath: "/workspace/HIS",
      }),
    );
    expect(await screen.findByText(/选择上方仓库后加载分支/)).toBeInTheDocument();
    expect(
      invokeMock.mock.calls.filter(([cmd]) => cmd === "list_branch_pr_candidates"),
    ).toHaveLength(0);

    fireEvent.click(await screen.findByRole("combobox", { name: /全部仓库/ }));
    fireEvent.click(await screen.findByRole("option", { name: "HIS" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_branch_pr_candidates", {
        projectPath: "/workspace/HIS",
        repoFilter: "HIS",
        targetOverrides: null,
        onlyBranches: null,
      }),
    );
  });

  it("surfaces a credential/network failure instead of an empty list", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_branch_pr_repos") {
        return Promise.resolve([{ name: "HIS", path: "/workspace/HIS" }]);
      }
      if (command === "list_branch_pr_candidates") {
        return Promise.reject("云效个人访问令牌不能为空（请在应用设置中配置）");
      }
      return Promise.resolve(null);
    });
    await renderAndSelectRepo();
    expect(await screen.findByText(/云效个人访问令牌不能为空/)).toBeInTheDocument();
  });

  it("marks MR state unknown when platform MR data is unavailable", async () => {
    mockList([scan([candidate()], { mrOk: false })]);
    await renderAndSelectRepo();
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
    await renderAndSelectRepo();

    expect(await screen.findByText("mine/develop/x")).toBeInTheDocument();
    expect(screen.queryByText("colleague/develop/y")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /我的提交/ }));
    expect(await screen.findByText("colleague/develop/y")).toBeInTheDocument();
  });

  it("renders the target branch even when case differs from the option list", async () => {
    // 实测 HIS：分支名里写的是 `Develop`，真实远端分支是 `develop`。
    // 不做大小写归一时 Radix Select 找不到匹配项，会把目标分支渲染成空白。
    mockList([
      scan([
        candidate({ branch: "feature/Develop/消息嵌入", targetBranch: "Develop" }),
        candidate({ branch: "feature/develop/other", targetBranch: "develop" }),
      ]),
    ]);
    await renderAndSelectRepo();
    await screen.findByText("feature/Develop/消息嵌入");

    // 每一行的目标分支下拉都要有可见的选中值（不能是空白）。
    const triggers = document.querySelectorAll(".pm-target-select button, .pm-target-select [role=combobox]");
    expect(triggers.length).toBe(2);
    for (const trigger of triggers) {
      expect((trigger.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("filters by branch-name search", async () => {
    mockList([
      scan([
        candidate({ branch: "alpha/develop/x" }),
        candidate({ branch: "beta/develop/y" }),
      ]),
    ]);
    await renderAndSelectRepo();
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
    await renderAndSelectRepo();
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
    await renderAndSelectRepo();
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
    await renderAndSelectRepo();
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
    const first = await renderAndSelectRepo();
    expect(await screen.findByText(/当前筛选下没有发起合并的分支/)).toBeInTheDocument();
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
    await renderAndSelectRepo();
    expect(await screen.findByText("mine/develop/x")).toBeInTheDocument();
  });

  it("only enables 发起合并请求 for pushed branches with unmerged commits", async () => {
    mockList([
      scan([
        candidate({ branch: "feature/develop/todo", unmerged: 2 }),
        // 已收尾的分支可删但不可发起——两类动作共用勾选，计数按各自属性区分。
        candidate({
          branch: "merged/v2/develop/QHDK-9",
          unmerged: 0,
          mergeState: "merged",
          mergedInto: "develop",
          deletable: true,
        }),
      ]),
    ]);
    await renderAndSelectRepo();
    await screen.findByText("feature/develop/todo");

    const createBtn = screen.getByRole("button", { name: /发起合并请求/ });
    expect(createBtn).toBeDisabled();

    // 勾已收尾分支：可删计数 +1，但不可发起。
    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    expect(screen.getByRole("button", { name: /发起合并请求/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /删除远端分支/ })).toBeEnabled();

    // 勾上未合并分支后发起才启用。
    fireEvent.click(screen.getByLabelText("feature/develop/todo"));
    expect(screen.getByRole("button", { name: /发起合并请求/ })).toBeEnabled();
  });

  it("prefills reviewers from the target-branch managers and creates MRs in one batch", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_branch_pr_repos") {
        return Promise.resolve([{ name: "HIS", path: "/workspace/HIS" }]);
      }
      if (command === "list_branch_pr_candidates") {
        return Promise.resolve([scan([candidate({ branch: "feature/develop/todo", unmerged: 2 })])]);
      }
      if (command === "codeup_branch_managers") return Promise.resolve(["张三", "李四"]);
      if (command === "codeup_create_mrs_batch") {
        return Promise.resolve([
          {
            repo: "HIS",
            repoPath: "/workspace/HIS",
            sourceBranch: "feature/develop/todo",
            targetBranch: "develop",
            created: true,
            mrId: "abc",
            mrLocalId: 3528,
            reason: "已发起合并请求（feature/develop/todo → develop）",
          },
        ]);
      }
      return Promise.resolve(null);
    });
    await renderAndSelectRepo();
    await screen.findByText("feature/develop/todo");

    fireEvent.click(screen.getByLabelText("feature/develop/todo"));
    fireEvent.click(screen.getByRole("button", { name: /发起合并请求/ }));

    // 确认弹层列出分支与目标分支，且审核人已按目标分支管理人员预填。
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("feature/develop/todo");
    expect(dialog.textContent).toContain("目标分支 develop");
    const textarea = await screen.findByPlaceholderText(/如：张三/);
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe("张三, 李四"));

    fireEvent.click(screen.getByRole("button", { name: /发起 1 个合并请求/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("codeup_create_mrs_batch", {
        projectPath: "/workspace/HIS",
        items: [
          {
            repoPath: "/workspace/HIS",
            repo: "HIS",
            sourceBranch: "feature/develop/todo",
            targetBranch: "develop",
            reviewers: ["张三", "李四"],
          },
        ],
      });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/✓ 已发起 HIS:feature\/develop\/todo #3528/)).toBeInTheDocument();
  });

  it("rescans only the changed branch when the target branch is switched", async () => {
    mockList([scan([candidate({ branch: "feature/develop/todo", unmerged: 2 })])]);
    await renderAndSelectRepo();
    await screen.findByText("feature/develop/todo");
    invokeMock.mockClear();

    // 打开行内目标分支下拉，改选 master。
    fireEvent.click(screen.getByRole("combobox", { name: /develop/ }));
    fireEvent.click(await screen.findByRole("option", { name: "master" }));

    // 关键契约：只重算被改的那一条（onlyBranches），且覆盖值随请求发回后端参与判定。
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("list_branch_pr_candidates", {
        projectPath: "/workspace/HIS",
        repoFilter: "HIS",
        targetOverrides: { "feature/develop/todo": "master" },
        onlyBranches: ["feature/develop/todo"],
      }),
    );
  });
});
