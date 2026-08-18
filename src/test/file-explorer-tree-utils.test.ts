import { describe, expect, it } from "vitest";
import type { TreeNode } from "../components/file-explorer/types";
import { compactTreeNodes } from "../components/file-explorer/treeUtils";

function dir(path: string, name: string, children: TreeNode[] | null = null): TreeNode {
  return {
    name,
    path,
    is_dir: true,
    is_gitignored: false,
    expanded: false,
    children,
  };
}

function file(path: string, name: string): TreeNode {
  return {
    name,
    path,
    is_dir: false,
    is_gitignored: false,
    expanded: false,
    children: null,
  };
}

describe("file explorer tree utilities", () => {
  it("compacts a chain of directories that has no files in the middle", () => {
    const nodes = [dir("/p/a", "a", [dir("/p/a/b", "b", [dir("/p/a/b/c", "c", [])])])];

    expect(compactTreeNodes(nodes)).toEqual([
      {
        ...dir("/p/a/b/c", "a/b/c", []),
      },
    ]);
  });

  it("stops compacting when a directory also contains a file", () => {
    const nodes = [
      dir("/p/a", "a", [dir("/p/a/b", "b", []), file("/p/a/package.json", "package.json")]),
    ];

    expect(compactTreeNodes(nodes)).toEqual(nodes);
  });

  it("preserves backend-compacted directories", () => {
    const nodes = [dir("/p/a/b/c", "a/b/c", [file("/p/a/b/c/index.ts", "index.ts")])];

    expect(compactTreeNodes(nodes)).toBe(nodes);
  });
});
