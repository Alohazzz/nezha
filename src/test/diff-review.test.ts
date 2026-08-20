import { describe, expect, it } from "vitest";
import {
  commentMatchesDiff,
  diffKeyString,
  isAnchorableRow,
  type DiffReviewComment,
} from "../components/git-diff/diffReview";

function diffComment(overrides: Partial<DiffReviewComment> = {}): DiffReviewComment {
  return {
    id: "d1",
    path: "src/foo.ts",
    startLine: 10,
    endLine: 10,
    snippet: "const x = 1;",
    text: "建议改名",
    status: "open",
    anchorable: false,
    diffKey: "",
    createdAt: 1,
    ...overrides,
  };
}

describe("diff review — 键控粒度", () => {
  it("commit 整仓视图匹配该 commit 的全部文件", () => {
    const a = diffComment({
      diffKey: diffKeyString({ kind: "commit", commitHash: "abc", filePath: "src/a.ts" }),
    });
    const b = diffComment({
      diffKey: diffKeyString({ kind: "commit", commitHash: "abc", filePath: "src/b.ts" }),
    });
    const other = diffComment({
      diffKey: diffKeyString({ kind: "commit", commitHash: "def", filePath: "src/a.ts" }),
    });
    const key = { kind: "commit", commitHash: "abc" } as const;
    expect(commentMatchesDiff(a, key)).toBe(true);
    expect(commentMatchesDiff(b, key)).toBe(true);
    expect(commentMatchesDiff(other, key)).toBe(false);
  });

  it("commit 单文件视图只匹配该文件", () => {
    const a = diffComment({
      diffKey: diffKeyString({ kind: "commit", commitHash: "abc", filePath: "src/a.ts" }),
    });
    const b = diffComment({
      diffKey: diffKeyString({ kind: "commit", commitHash: "abc", filePath: "src/b.ts" }),
    });
    const key = { kind: "commit", commitHash: "abc", filePath: "src/a.ts" } as const;
    expect(commentMatchesDiff(a, key)).toBe(true);
    expect(commentMatchesDiff(b, key)).toBe(false);
  });

  it("工作区 staged / unstaged 互不相通", () => {
    const staged = diffComment({
      diffKey: diffKeyString({ kind: "worktree", filePath: "src/a.ts", staged: true }),
    });
    const unstaged = diffComment({
      diffKey: diffKeyString({ kind: "worktree", filePath: "src/a.ts", staged: false }),
    });
    expect(
      commentMatchesDiff(staged, { kind: "worktree", filePath: "src/a.ts", staged: true }),
    ).toBe(true);
    expect(
      commentMatchesDiff(staged, { kind: "worktree", filePath: "src/a.ts", staged: false }),
    ).toBe(false);
    expect(
      commentMatchesDiff(unstaged, { kind: "worktree", filePath: "src/a.ts", staged: false }),
    ).toBe(true);
  });

  it("工作区与 commit 系互不相通", () => {
    const worktree = diffComment({
      diffKey: diffKeyString({ kind: "worktree", filePath: "src/a.ts", staged: false }),
    });
    expect(
      commentMatchesDiff(worktree, { kind: "commit", commitHash: "abc", filePath: "src/a.ts" }),
    ).toBe(false);
  });
});

describe("diff review — 锚定判定", () => {
  it("工作区 diff 只有 add / context 可 @ 锚定", () => {
    expect(isAnchorableRow("add", true)).toBe(true);
    expect(isAnchorableRow("context", true)).toBe(true);
    expect(isAnchorableRow("remove", true)).toBe(false);
  });

  it("commit diff 一律纯文本锚", () => {
    expect(isAnchorableRow("add", false)).toBe(false);
    expect(isAnchorableRow("context", false)).toBe(false);
    expect(isAnchorableRow("remove", false)).toBe(false);
  });
});
