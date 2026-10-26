import { describe, expect, it } from "vitest";
import {
  guessDiffLanguage,
  parseCodexDiffText,
  parseCodexFileDiff,
  summarizeCodexDiffFiles,
  truncateCodexDiffFile,
} from "../components/codex-stream/codexDiffParse";

// 表驱动（先例：git-diff-parse.test.ts）。接缝：纯解析函数——
// unified diff 文本 / 上游 per-file 结构 → hunk 结构 + +N/−N 派生。
// 解析必须宽容：截断、坏行、无换行符标记都不抛异常。

describe("parseCodexDiffText", () => {
  it("parses a multi-hunk modified file with line numbers and stats", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 1111111..2222222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,4 +1,4 @@",
      " import { x } from './x';",
      "-const a = 1;",
      "+const a = 2;",
      " ",
      "@@ -20,3 +20,4 @@",
      " keep()",
      "+added()",
      " still()",
      "",
    ].join("\n");

    const [file] = parseCodexDiffText(diff);

    expect(file).toBeDefined();
    expect(file!.oldPath).toBe("src/app.ts");
    expect(file!.newPath).toBe("src/app.ts");
    expect(file!.changeKind).toBe("modified");
    expect(file!.additions).toBe(2);
    expect(file!.deletions).toBe(1);
    expect(file!.hunks).toHaveLength(2);

    const hunk1 = file!.hunks[0]!;
    expect(hunk1.oldStart).toBe(1);
    expect(hunk1.newStart).toBe(1);
    expect(hunk1.rows.map((r) => r.type)).toEqual(["context", "del", "add", "context"]);
    expect(hunk1.rows[1]!.content).toBe("const a = 1;");
    expect(hunk1.rows[1]!.oldLine).toBe(2);
    expect(hunk1.rows[2]!.content).toBe("const a = 2;");
    expect(hunk1.rows[2]!.newLine).toBe(2);

    const hunk2 = file!.hunks[1]!;
    expect(hunk2.oldStart).toBe(20);
    expect(hunk2.newStart).toBe(20);
    expect(hunk2.rows[1]!.type).toBe("add");
    expect(hunk2.rows[1]!.newLine).toBe(21);
  });

  it("classifies a new file (added) and handles /dev/null old path", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+export const fresh = true;",
      "+export const ready = 1;",
      "",
    ].join("\n");

    const [file] = parseCodexDiffText(diff);

    expect(file!.changeKind).toBe("added");
    expect(file!.oldPath).toBeNull();
    expect(file!.newPath).toBe("src/new.ts");
    expect(file!.additions).toBe(2);
    expect(file!.deletions).toBe(0);
  });

  it("classifies a deleted file", () => {
    const diff = [
      "diff --git a/src/old.ts b/src/old.ts",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone()",
      "",
    ].join("\n");

    const [file] = parseCodexDiffText(diff);

    expect(file!.changeKind).toBe("deleted");
    expect(file!.newPath).toBeNull();
    expect(file!.deletions).toBe(1);
    expect(file!.additions).toBe(0);
  });

  it("classifies a rename via git extended headers", () => {
    const diff = [
      "diff --git a/src/before.ts b/src/after.ts",
      "similarity index 91%",
      "rename from src/before.ts",
      "rename to src/after.ts",
      "--- a/src/before.ts",
      "+++ b/src/after.ts",
      "@@ -1 +1 @@",
      "-old()",
      "+new()",
      "",
    ].join("\n");

    const [file] = parseCodexDiffText(diff);

    expect(file!.changeKind).toBe("renamed");
    expect(file!.oldPath).toBe("src/before.ts");
    expect(file!.newPath).toBe("src/after.ts");
    expect(file!.additions).toBe(1);
    expect(file!.deletions).toBe(1);
  });

  it("tolerates the no-newline-at-eof marker without counting it as a row", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 5555555..6666666 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1 +1 @@",
      "-last old line",
      "\\ No newline at end of file",
      "+last new line",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const [file] = parseCodexDiffText(diff);

    expect(file!.additions).toBe(1);
    expect(file!.deletions).toBe(1);
    // `\ No newline` 保留为 meta 行（先例：git-diff parse.ts），但不计入 +/− 统计
    expect(file!.hunks[0]!.rows.map((r) => r.type)).toEqual(["del", "meta", "add", "meta"]);
  });

  it.each([
    { name: "empty input", input: "" },
    { name: "garbage text", input: "this is not a diff at all\njust words\n" },
    { name: "header without hunks", input: "diff --git a/x.ts b/x.ts\nindex aaa..bbb 100644\n" },
    {
      name: "truncated mid-hunk",
      input: [
        "diff --git a/big.ts b/big.ts",
        "--- a/big.ts",
        "+++ b/big.ts",
        "@@ -1,100 +1,100 @@",
        "-one",
        "+two",
      ].join("\n"),
    },
  ])("returns a best-effort partial result without throwing: $name", ({ input }) => {
    expect(() => parseCodexDiffText(input)).not.toThrow();
    const files = parseCodexDiffText(input);
    expect(Array.isArray(files)).toBe(true);
    for (const f of files) {
      expect(f.additions).toBeGreaterThanOrEqual(0);
      expect(f.deletions).toBeGreaterThanOrEqual(0);
    }
  });

  it("parses multiple files from one raw diff text", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a1",
      "+a2",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-b1",
      "+b2",
      "",
    ].join("\n");

    const files = parseCodexDiffText(diff);

    expect(files.map((f) => f.newPath)).toEqual(["a.ts", "b.ts"]);
    expect(summarizeCodexDiffFiles(files)).toEqual({ additions: 2, deletions: 2 });
  });
});

describe("parseCodexFileDiff", () => {
  it("prefers the structured change kind over header inference", () => {
    const change = {
      path: "src/moved.ts",
      kind: { type: "update", movePath: "src/renamed.ts" } as const,
      diff: [
        "--- a/src/moved.ts",
        "+++ b/src/moved.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ].join("\n"),
    };

    const file = parseCodexFileDiff(change);

    expect(file.changeKind).toBe("renamed");
    expect(file.newPath).toBe("src/renamed.ts");
    expect(file.oldPath).toBe("src/moved.ts");
    expect(file.additions).toBe(1);
    expect(file.deletions).toBe(1);
  });

  it("maps structured add/delete kinds to badges with hunks from the diff text", () => {
    const added = parseCodexFileDiff({
      path: "n.ts",
      kind: { type: "add" } as const,
      diff: "--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+hi\n",
    });
    expect(added.changeKind).toBe("added");

    const deleted = parseCodexFileDiff({
      path: "d.ts",
      kind: { type: "delete" } as const,
      diff: "--- a/d.ts\n+++ /dev/null\n@@ -1,0 +0,1 @@\n-bye\n",
    });
    expect(deleted.changeKind).toBe("deleted");
    expect(deleted.hunks).toHaveLength(1);
  });

  it("survives a structured change with garbage diff text", () => {
    const file = parseCodexFileDiff({ path: "w.ts", kind: { type: "add" } as const, diff: "junk" });

    expect(file.changeKind).toBe("added");
    expect(file.hunks).toEqual([]);
    expect(file.additions).toBe(0);
    expect(file.path).toBe("w.ts");
  });
});

describe("truncateCodexDiffFile", () => {
  it("keeps the first N rows and reports truncation", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      type: "add" as const,
      content: `line ${i}`,
      newLine: i + 1,
    }));
    const file = {
      path: "big.ts",
      oldPath: null,
      newPath: "big.ts",
      changeKind: "added" as const,
      hunks: [{ header: "@@ -0,0 +1,30 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 30, rows }],
      additions: 30,
      deletions: 0,
    };

    const truncated = truncateCodexDiffFile(file, 10);

    expect(truncated.file.hunks[0]!.rows).toHaveLength(10);
    expect(truncated.totalRows).toBe(30);
    expect(truncated.omittedRows).toBe(20);
    expect(truncated.truncated).toBe(true);
  });

  it("is a no-op when under the limit", () => {
    const file = {
      path: "s.ts",
      oldPath: null,
      newPath: "s.ts",
      changeKind: "added" as const,
      hunks: [
        { header: "@@ -0,0 +1,2 @@", oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, rows: [{ type: "add" as const, content: "a", newLine: 1 }, { type: "add" as const, content: "b", newLine: 2 }] },
      ],
      additions: 2,
      deletions: 0,
    };

    const truncated = truncateCodexDiffFile(file, 2000);

    expect(truncated.truncated).toBe(false);
    expect(truncated.omittedRows).toBe(0);
  });
});

describe("guessDiffLanguage", () => {
  it.each([
    { path: "src/App.tsx", expected: "tsx" },
    { path: "src/main.rs", expected: "rust" },
    { path: "py/app.py", expected: "python" },
    { path: "README.md", expected: "markdown" },
    { path: "no/extension", expected: null },
    { path: "", expected: null },
  ])("maps $path -> $expected", ({ path, expected }) => {
    expect(guessDiffLanguage(path)).toBe(expected);
  });
});
