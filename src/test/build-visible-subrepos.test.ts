import { describe, expect, it } from "vitest";
import {
  DEFAULT_VISIBLE_SUBREPOS,
  filterVisibleRepos,
  resolveVisibleSubrepos,
} from "../components/build/visibleSubrepos";

function repo(name: string, is_submodule: boolean, path = `/workspace/HIS/${name}`) {
  return { name, path, is_submodule };
}

describe("visibleSubrepos", () => {
  it("keeps the root repo and hides unmatched submodules by default", () => {
    const list = [
      repo("HIS", false, "/workspace/HIS"),
      repo("DrugInOut", true),
      repo("Nto.Other", true),
    ];
    const visible = filterVisibleRepos(list);
    expect(visible.map((r) => r.name)).toEqual(["HIS", "DrugInOut"]);
  });

  it("shows Hsp.Win by default", () => {
    expect(DEFAULT_VISIBLE_SUBREPOS).toContain("Hsp.Win");
    const visible = filterVisibleRepos([
      repo("HIS", false, "/workspace/HIS"),
      repo("Hsp.Win", true),
    ]);
    expect(visible.map((r) => r.name)).toEqual(["HIS", "Hsp.Win"]);
  });

  it("matches a configured keyword against the submodule path as well as its name", () => {
    const visible = filterVisibleRepos(
      [repo("Svc", true, "/workspace/HIS/Hsp.Win/Svc"), repo("Other", true)],
      ["hsp.win"],
    );
    expect(visible.map((r) => r.name)).toEqual(["Svc"]);
  });

  it("treats an explicit empty whitelist as 'show every repo'", () => {
    const list = [repo("HIS", false, "/workspace/HIS"), repo("Anything", true)];
    expect(filterVisibleRepos(list, []).map((r) => r.name)).toEqual(["HIS", "Anything"]);
  });
});

describe("resolveVisibleSubrepos", () => {
  const discovered = [
    { name: "Hsp.Win", path: "/workspace/HIS/Hsp.Win" },
    { name: "Nto.His/Nto.His.DrugInOut", path: "/workspace/HIS/Nto.His/Nto.His.DrugInOut" },
    { name: "Nto.His/Nto.His.Term", path: "/workspace/HIS/Nto.His/Nto.His.Term" },
  ];

  // 关键回归：默认配置里的缩写关键字必须勾中真实仓库名，否则下拉会「已选 3 项但没勾上」。
  it("aligns abbreviated saved keywords to the real discovered repo names", () => {
    expect(resolveVisibleSubrepos(["DrugInOut", "Term", "Hsp.Win"], discovered)).toEqual([
      "Nto.His/Nto.His.DrugInOut",
      "Nto.His/Nto.His.Term",
      "Hsp.Win",
    ]);
  });

  it("keeps an exact name unchanged", () => {
    expect(resolveVisibleSubrepos(["Hsp.Win"], discovered)).toEqual(["Hsp.Win"]);
  });

  // 仓库可能只是当前未初始化：发现不到时保留原关键字，不能悄悄清掉用户配置。
  it("preserves a keyword that matches nothing rather than dropping it", () => {
    expect(resolveVisibleSubrepos(["NotInitialized"], discovered)).toEqual([
      "NotInitialized",
    ]);
  });

  it("trims, ignores blanks and de-duplicates", () => {
    expect(
      resolveVisibleSubrepos([" Term ", "", "Term", "  "], discovered),
    ).toEqual(["Nto.His/Nto.His.Term"]);
  });
});
