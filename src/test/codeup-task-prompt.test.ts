import { describe, expect, it } from "vitest";
import {
  buildCodeupTaskPrompt,
  buildCodeupMergeContinuation,
} from "../components/codeup/taskPrompt";
import type { CodeupMr } from "../types";

const mr = { localId: 7, sourceBranch: "feature", targetBranch: "main" } as CodeupMr;

describe("Codeup merge conflict instructions", () => {
  it("permits file edits and validation commands while keeping merge operations in Git", () => {
    const prompt = buildCodeupTaskPrompt(mr, "merge");
    expect(prompt).not.toContain("只使用 git 命令");
    expect(prompt).toContain("允许使用文件读取、编辑工具");
    expect(prompt).toContain("构建、测试和验收命令");
    expect(prompt).toContain("不得调用平台/接口合并");
  });

  it.each(["merge", "conflict"] as const)(
    "%s treats merge conflicts as expected and requires verification",
    (kind) => {
      const prompt = buildCodeupTaskPrompt(mr, kind);
      expect(prompt).toContain("退出码 1");
      expect(prompt).toContain("git diff --name-only --diff-filter=U");
      expect(prompt).toContain("继续解决");
      expect(prompt).toContain("git diff --check");
      expect(prompt).toContain("git apply");
      expect(prompt).toContain("重新读取当前文件");
      expect(prompt).toContain("使用编辑工具逐段修改");
      expect(prompt).not.toContain("任何一步失败即停下");
    },
  );

  it.each(["merge", "conflict"] as const)(
    "%s continuation keeps the checkout and correct push destination",
    (kind) => {
      const prompt = buildCodeupMergeContinuation(kind, "feature", "main");
      expect(prompt).toContain("保留当前修改");
      expect(prompt).toContain("禁止重新 checkout -f");
      expect(prompt).toContain("git apply");
      expect(prompt).toContain(`HEAD:${kind === "merge" ? "main" : "feature"}`);
    },
  );
});
