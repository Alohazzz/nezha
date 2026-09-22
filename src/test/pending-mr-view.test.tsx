import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
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

  it("row-level delete prunes that row even when its checkbox is not checked", async () => {
    // 回归：行内「删除」曾复用基于勾选集的 startPrune——未勾选时静默 return（点了毫无
    // 反应），勾了别的行时删的还不是被点击的行。行内删除必须始终只处理自己这一行。
    const rowBranch = candidate({
      branch: "merged/v2/develop/QHDK-9",
      unmerged: 0,
      mergeState: "merged",
      mergedInto: "develop",
      deletable: true,
      skipReason: "",
    });
    const otherBranch = candidate({
      branch: "merged/v2/develop/QHDK-10",
      unmerged: 0,
      mergeState: "merged",
      mergedInto: "develop",
      deletable: true,
      skipReason: "",
    });
    mockList(
      [scan([rowBranch, otherBranch])],
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

    // 不勾选任何复选框，直接点这一行的「删除」。
    const row = screen
      .getByText("merged/v2/develop/QHDK-9")
      .closest(".pm-card") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /删除/ }));

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

    // 确认后真删这一行。
    fireEvent.click(await screen.findByRole("button", { name: /删除 1 个远端分支/ }));
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
    expect(await screen.findByText(/✓ 已删除 HIS:merged\/v2\/develop\/QHDK-9/)).toBeInTheDocument();
  });

  it("hides branches whose remote copy is already gone after a rescan", async () => {
    // 扫描侧契约：远端已无该分支的行不得以「已合并，可删除」留在列表里（后端会把
    // pushed 置 false / 带 skipReason），否则用户勾选后必然被 dry-run 打回。
    mockList([
      scan([
        candidate({
          branch: "merged/v2/develop/gone",
          unmerged: 0,
          mergeState: "merged",
          mergedInto: "develop",
          pushed: false,
          deletable: false,
          skipReason: "远端已无该分支",
        }),
      ]),
    ]);
    await renderAndSelectRepo();
    expect(
      await screen.findByText(/当前筛选下没有发起合并的分支/),
    ).toBeInTheDocument();
    expect(screen.queryByText("merged/v2/develop/gone")).not.toBeInTheDocument();
  });

  it("says the branches are already gone when every skip reason reports a missing remote ref", async () => {
    // dry-run 全部跳过且原因都是「远端已无该分支」是**达成**而非拒绝：文案若与
    // 「均不满足删除条件」混用，用户会以为点了没有任何反应。
    mockList(
      [
        scan([
          candidate({
            branch: "merged/v2/develop/QHDK-9",
            unmerged: 0,
            mergeState: "merged",
            mergedInto: "develop",
            deletable: true,
            skipReason: "",
          }),
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
          reason: "远端已无该分支",
        },
      ],
    );
    await renderAndSelectRepo();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));

    expect(await screen.findByText(/所选分支在远端已不存在/)).toBeInTheDocument();
    expect(screen.queryByText(/均不满足删除条件/)).not.toBeInTheDocument();
  });

  it("counts an idempotent already-gone receipt as success, not failure", async () => {
    // 执行阶段才发现远端已无该分支（exists/fetch 过了之后被平台或他人删掉）：
    // 后端回执 deleted=true + 「删除目标已达成」，前端必须计入「已删除」而非「失败」。
    mockList(
      [
        scan([
          candidate({
            branch: "merged/v2/develop/QHDK-9",
            unmerged: 0,
            mergeState: "merged",
            mergedInto: "develop",
            deletable: true,
            skipReason: "",
          }),
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
                reason: "远端已无该分支，删除目标已达成（分支可能已被平台或他人删除）",
              },
            ],
    );
    await renderAndSelectRepo();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));
    fireEvent.click(await screen.findByRole("button", { name: /删除 1 个远端分支/ }));

    expect(await screen.findByText(/已删除 1 个远端分支/)).toBeInTheDocument();
    expect(screen.queryByText(/失败 1 个/)).not.toBeInTheDocument();
    expect(
      await screen.findByText(/✓ 已删除 HIS:merged\/v2\/develop\/QHDK-9/),
    ).toBeInTheDocument();
    expect(screen.getByText(/删除目标已达成/)).toBeInTheDocument();
  });

  it("opens the confirm dialog immediately while the dry-run gate is still running", async () => {
    // 操作体验：dry-run 门禁（云效 API + ls-remote + fetch）要跑好几秒，点击删除后
    // 确认框必须**立刻**出现，确认按钮显示检查态，门禁通过才点亮——不能让用户干等。
    let resolveDryRun!: (v: unknown) => void;
    mockList(
      [
        scan([
          candidate({
            branch: "merged/v2/develop/QHDK-9",
            unmerged: 0,
            mergeState: "merged",
            mergedInto: "develop",
            deletable: true,
            skipReason: "",
          }),
        ]),
      ],
      (dryRun) => {
        if (!dryRun) return [];
        return new Promise((res) => {
          resolveDryRun = res;
        });
      },
    );
    await renderAndSelectRepo();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));

    // dry-run 尚未返回，弹窗必须已经出现且列出该分支。
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("merged/v2/develop/QHDK-9");
    // 确认按钮处于检查态（禁用），取消始终可用。
    expect(screen.getByRole("button", { name: /检查删除条件/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeEnabled();

    // 门禁通过 → 确认按钮点亮为可执行的删除。
    await act(async () => {
      resolveDryRun([
        {
          repo: "HIS",
          repoPath: "/workspace/HIS",
          branch: "merged/v2/develop/QHDK-9",
          targetBranch: "develop",
          deleted: false,
          deletable: true,
          reason: "已完整合入 origin/develop",
        },
      ]);
    });
    expect(
      screen.getByRole("button", { name: /删除 1 个远端分支/ }),
    ).toBeEnabled();
  });

  it("canceling during the dry-run check ignores the stale result", async () => {
    // 检查阶段取消后，在途 dry-run 迟到的结果不得把弹层重新打开（run 作废守卫）。
    let resolveDryRun!: (v: unknown) => void;
    mockList(
      [
        scan([
          candidate({
            branch: "merged/v2/develop/QHDK-9",
            unmerged: 0,
            mergeState: "merged",
            mergedInto: "develop",
            deletable: true,
            skipReason: "",
          }),
        ]),
      ],
      (dryRun) => {
        if (!dryRun) return [];
        return new Promise((res) => {
          resolveDryRun = res;
        });
      },
    );
    await renderAndSelectRepo();
    await screen.findByText("merged/v2/develop/QHDK-9");

    fireEvent.click(screen.getByLabelText("merged/v2/develop/QHDK-9"));
    fireEvent.click(screen.getByRole("button", { name: /删除远端分支/ }));
    await screen.findByRole("dialog");

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => {
      resolveDryRun([
        {
          repo: "HIS",
          repoPath: "/workspace/HIS",
          branch: "merged/v2/develop/QHDK-9",
          targetBranch: "develop",
          deleted: false,
          deletable: true,
          reason: "已完整合入 origin/develop",
        },
      ]);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
      if (command === "codeup_list_members") {
        return Promise.resolve([
          { name: "张三", userId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
          { name: "李四", userId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
          { name: "王五", userId: "cccccccccccccccccccccccc" },
        ]);
      }
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

    // 确认弹层列出分支与目标分支，且审核人已按目标分支的默认评审人预填成 chip。
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("feature/develop/todo");
    expect(dialog.textContent).toContain("目标分支 develop");
    await waitFor(() => {
      expect(screen.getByLabelText("移除评审人 张三")).toBeInTheDocument();
      expect(screen.getByLabelText("移除评审人 李四")).toBeInTheDocument();
    });

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

  it("lets the user pick reviewers from the org member list", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_branch_pr_repos") {
        return Promise.resolve([{ name: "HIS", path: "/workspace/HIS" }]);
      }
      if (command === "list_branch_pr_candidates") {
        return Promise.resolve([scan([candidate({ branch: "feature/develop/todo", unmerged: 2 })])]);
      }
      // 保护规则拿不到默认评审人：模拟真实里的「预填为空、必须自己选」。
      if (command === "codeup_branch_managers") {
        return Promise.reject(new Error("HTTP 404 [NotFound]: Not Found"));
      }
      if (command === "codeup_list_members") {
        return Promise.resolve([
          { name: "苏一", userId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
          { name: "陈学清", userId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
        ]);
      }
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

    // 打开成员列表并勾选一个成员（值以人名传递，后端再解析成 userID）。
    const input = await screen.findByPlaceholderText(/输入姓名搜索/);
    fireEvent.focus(input);
    fireEvent.click(await screen.findByRole("button", { name: /苏一/ }));
    await waitFor(() => expect(screen.getByLabelText("移除评审人 苏一")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /发起 1 个合并请求/ }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("codeup_create_mrs_batch", {
        projectPath: "/workspace/HIS",
        items: [
          expect.objectContaining({
            sourceBranch: "feature/develop/todo",
            reviewers: ["苏一"],
          }),
        ],
      });
    });
  });

  it("surfaces per-item reviewer resolution failures in the result panel", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_branch_pr_repos") {
        return Promise.resolve([{ name: "HIS", path: "/workspace/HIS" }]);
      }
      if (command === "list_branch_pr_candidates") {
        return Promise.resolve([scan([candidate({ branch: "feature/develop/todo", unmerged: 2 })])]);
      }
      if (command === "codeup_branch_managers") return Promise.resolve(["查无此人"]);
      if (command === "codeup_list_members") {
        return Promise.resolve([{ name: "苏一", userId: "aaaaaaaaaaaaaaaaaaaaaaaa" }]);
      }
      // 后端在审核人解析失败时**不创建** MR，而是逐条回执说明原因。
      if (command === "codeup_create_mrs_batch") {
        return Promise.resolve([
          {
            repo: "HIS",
            repoPath: "/workspace/HIS",
            sourceBranch: "feature/develop/todo",
            targetBranch: "develop",
            created: false,
            mrId: null,
            mrLocalId: null,
            reason: "云效组织成员里找不到审核人「查无此人」，请检查姓名或改填云效用户 ID",
          },
        ]);
      }
      return Promise.resolve(null);
    });
    await renderAndSelectRepo();
    await screen.findByText("feature/develop/todo");

    fireEvent.click(screen.getByLabelText("feature/develop/todo"));
    fireEvent.click(screen.getByRole("button", { name: /发起合并请求/ }));
    fireEvent.click(await screen.findByRole("button", { name: /发起 1 个合并请求/ }));

    // 审核人解析失败必须逐条可见，不能静默发出一条没有评审人的 MR。
    expect(await screen.findByText(/找不到审核人「查无此人」/)).toBeInTheDocument();
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
