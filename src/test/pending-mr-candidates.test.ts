import { describe, expect, it } from "vitest";
import type { PendingBranchCandidate, PendingBranchRepoScan } from "../types";
import {
  applyFilters,
  badgesFor,
  candidateKey,
  commitSummary,
  flattenScans,
  isPrCandidate,
  isVisibleBranch,
  relativeTime,
  sortCandidates,
  targetSourceLabel,
  toPruneTarget,
} from "../components/codeup/pendingMr";

/** 构造一个「待发起」候选，字段按需覆盖。 */
function branch(overrides: Partial<PendingBranchCandidate> = {}): PendingBranchCandidate {
  return {
    branch: "fix/v2.20260901/develop/QHDK-1-x",
    repo: "HIS",
    repoPath: "/workspace/HIS",
    pushed: true,
    protected: false,
    protectedSource: null,
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
    remoteOnly: false,
    ...overrides,
  };
}

describe("pending-mr candidate rules", () => {
  it("treats pushed + unmerged>0 + no open MR as a candidate", () => {
    expect(isPrCandidate(branch())).toBe(true);
    // 无开放 MR 但已合并 → 不是「待发起」候选
    expect(isPrCandidate(branch({ unmerged: 0, mergeState: "merged" }))).toBe(false);
    // 已有开放 MR → 不是候选（不重复发起）
    expect(isPrCandidate(branch({ openMrId: 3527 }))).toBe(false);
    // 未推送 → 不是候选
    expect(isPrCandidate(branch({ pushed: false, unmerged: 0 }))).toBe(false);
    // 平台 MR 数据不可用时不能靠「无开放 MR」下结论
    expect(isPrCandidate(branch({ openMrId: 3527 }), false)).toBe(true);
  });

  it("keeps merged-and-pushed branches visible for cleanup", () => {
    const merged = branch({ unmerged: 0, mergeState: "merged", mergedInto: "master", deletable: true });
    expect(isVisibleBranch(merged, true)).toBe(true);
    // 未推送的已合并分支（只存在于本地）不应出现在列表里
    expect(isVisibleBranch(branch({ pushed: false, unmerged: 0, mergeState: "merged" }), true)).toBe(false);
    // 有开放 MR 的未合并分支不出现
    expect(isVisibleBranch(branch({ openMrId: 1 }), true)).toBe(false);
    // MR 数据不可用时不能拿「无开放 MR」筛人：该分支仍要显示（否则凭据失败被误读成空集）
    expect(isVisibleBranch(branch({ openMrId: 1 }), false)).toBe(true);
  });
});

describe("pending-mr filters", () => {
  it("filters by mine and by branch-name query", () => {
    const mine = branch({ branch: "fix/develop/qhdk-1", mine: true });
    const others = branch({ branch: "hotfix/develop/qhdk-2", mine: false });
    const list = [mine, others];

    expect(applyFilters(list, { mineOnly: true, query: "" })).toEqual([mine]);
    expect(applyFilters(list, { mineOnly: false, query: "" })).toEqual(list);
    // 搜索大小写不敏感，且只在分支名上匹配
    expect(applyFilters(list, { mineOnly: false, query: "QHDK-2" })).toEqual([others]);
    expect(applyFilters(list, { mineOnly: true, query: "hotfix" })).toEqual([]);
  });
});

describe("pending-mr sorting", () => {
  it("puts my branches first, then most recent, then stable by repo/branch", () => {
    const olderMine = branch({ branch: "a-mine", mine: true, lastCommitAt: 100 });
    const newerOther = branch({ branch: "b-other", mine: false, lastCommitAt: 999 });
    const newerMine = branch({ branch: "c-mine", mine: true, lastCommitAt: 500 });
    const sorted = sortCandidates([olderMine, newerOther, newerMine]);
    expect(sorted.map((b) => b.branch)).toEqual(["c-mine", "a-mine", "b-other"]);
  });
});

describe("pending-mr badges", () => {
  it("renders explicit no-MR badge when platform data is available", () => {
    const badges = badgesFor(branch(), true).map((b) => b.text);
    expect(badges).toContain("未合并");
    expect(badges).toContain("无 MR");
    expect(badges).toContain("我的提交");
  });

  it("marks MR state unknown instead of pretending there is none", () => {
    const badges = badgesFor(branch(), false).map((b) => b.text);
    expect(badges).toContain("MR 未知");
    expect(badges).not.toContain("无 MR");
  });

  it("shows merged target and existing MR id", () => {
    const badges = badgesFor(
      branch({ unmerged: 0, mergeState: "merged", mergedInto: "master", openMrId: 3527 }),
      true,
    ).map((b) => b.text);
    expect(badges).toContain("已合并进 master");
    expect(badges).toContain("已有 MR #3527");
  });

  it("shows partial-merge and protected states", () => {
    expect(badgesFor(branch({ mergeState: "partial" }), true).map((b) => b.text)).toContain("部分合并");
    expect(badgesFor(branch({ protected: true }), true).map((b) => b.text)).toContain("受保护");
    expect(badgesFor(branch({ pushed: false }), true).map((b) => b.text)).toContain("未推送");
  });

  // #93：远端独有的分支要能与本地分支在行上区分，否则用户不知道本地没有工作副本。
  it("marks remote-only branches so they are distinguishable from local ones", () => {
    const badges = badgesFor(branch({ remoteOnly: true }), true).map((b) => b.text);
    expect(badges).toContain("仅远端");
    expect(badgesFor(branch(), true).map((b) => b.text)).not.toContain("仅远端");
  });
});

describe("pending-mr helpers", () => {
  it("labels the target-branch inference source", () => {
    expect(targetSourceLabel("config")).toBe("项目配置");
    expect(targetSourceLabel("name")).toBe("按分支名推断");
    expect(targetSourceLabel("default")).toBe("默认值");
  });

  it("formats a relative time in Chinese", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now / 1000, now)).toBe("刚刚");
    expect(relativeTime(now / 1000 - 120, now)).toBe("2 分钟前");
    expect(relativeTime(now / 1000 - 7200, now)).toBe("2 小时前");
    expect(relativeTime(now / 1000 - 2 * 86400, now)).toBe("2 天前");
    expect(relativeTime(0, now)).toBe("");
  });

  it("summarizes unmerged count, author and time", () => {
    const summary = commitSummary(branch({ unmerged: 3, lastCommitAuthor: "苏一" }));
    expect(summary).toContain("3 个未合并提交");
    expect(summary).toContain("苏一");
  });

  it("flattens only successful repo scans, and only showable branches", () => {
    const scans: PendingBranchRepoScan[] = [
      { name: "HIS", path: "/a", ok: true, message: "", platformOk: true, mrOk: true, branches: [branch()] },
      { name: "Broken", path: "/b", ok: false, message: "boom", platformOk: false, mrOk: false, branches: [branch()] },
    ];
    expect(flattenScans(scans)).toHaveLength(1);

    // 未推送的 WIP 分支不应进入列表（既非待发起、也删不了）。
    const wip = flattenScans([
      {
        name: "HIS",
        path: "/a",
        ok: true,
        message: "",
        platformOk: true,
        mrOk: true,
        branches: [branch({ pushed: false, unmerged: 0 })],
      },
    ]);
    expect(wip).toHaveLength(0);

    // 平台 MR 数据不可用的仓库，其分支按「MR 未知」放行而不是被筛掉。
    const unknown = flattenScans([
      {
        name: "HIS",
        path: "/a",
        ok: true,
        message: "",
        platformOk: false,
        mrOk: false,
        branches: [branch({ openMrId: 99 })],
      },
    ]);
    expect(unknown).toHaveLength(1);

    // #93：远端独有的分支走同一套可见性规则——未合并的可发起、已合并的可清理。
    const remoteOnly = flattenScans([
      {
        name: "HIS",
        path: "/a",
        ok: true,
        message: "",
        platformOk: true,
        mrOk: true,
        branches: [
          branch({ branch: "feature/develop/remote-only", remoteOnly: true }),
          branch({
            branch: "feature/develop/remote-merged",
            remoteOnly: true,
            unmerged: 0,
            mergeState: "merged",
            deletable: true,
          }),
        ],
      },
    ]);
    expect(remoteOnly).toHaveLength(2);
  });

  it("keys branches by repo path so same-named branches stay distinct", () => {
    const a = branch({ repoPath: "/a", branch: "fix/x" });
    const b = branch({ repoPath: "/b", branch: "fix/x" });
    expect(candidateKey(a)).not.toBe(candidateKey(b));
  });

  it("builds the prune target with the row's target branch", () => {
    expect(toPruneTarget(branch({ targetBranch: "master" }))).toEqual({
      repoPath: "/workspace/HIS",
      repo: "HIS",
      branch: "fix/v2.20260901/develop/QHDK-1-x",
      targetBranch: "master",
    });
  });
});
