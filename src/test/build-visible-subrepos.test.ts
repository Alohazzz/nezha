import { describe, expect, it } from "vitest";
import { filterVisibleRepos, resolveVisibleSubrepos } from "../components/build/visibleSubrepos";

function repo(name: string, is_submodule: boolean, path = `/workspace/HIS/${name}`) {
  return { name, path, is_submodule };
}

describe("visibleSubrepos", () => {
  // 缺省 = 不限制：主仓库与全部发现的仓库都列出（旧版硬编码默认白名单已删除）。
  it("lists every discovered repo when no whitelist is configured", () => {
    const list = [
      repo("HIS", false, "/workspace/HIS"),
      repo("DrugInOut", true),
      repo("web", false, "/workspace/HIS/web"),
    ];
    expect(filterVisibleRepos(list).map((r) => r.name)).toEqual([
      "HIS",
      "DrugInOut",
      "web",
    ]);
  });

  it("treats an explicit empty whitelist as 'show every repo'", () => {
    const list = [repo("HIS", false, "/workspace/HIS"), repo("Anything", true)];
    expect(filterVisibleRepos(list, []).map((r) => r.name)).toEqual(["HIS", "Anything"]);
  });

  it("keeps the root repo and hides unmatched non-root repos when a whitelist is set", () => {
    const list = [
      repo("HIS", false, "/workspace/HIS"),
      repo("DrugInOut", true),
      repo("Nto.Other", true),
      repo("web", false, "/workspace/HIS/web"),
    ];
    const visible = filterVisibleRepos(list, ["DrugInOut"]);
    expect(visible.map((r) => r.name)).toEqual(["HIS", "DrugInOut"]);
  });

  it("matches a configured keyword against the repo path as well as its name", () => {
    const visible = filterVisibleRepos(
      [repo("Svc", true, "/workspace/HIS/Hsp.Win/Svc"), repo("Other", true)],
      ["hsp.win"],
    );
    expect(visible.map((r) => r.name)).toEqual(["Svc"]);
  });

  // rootPath 指认主仓库：即使它不在列表首位也不受白名单过滤。
  it("always keeps the repo matching rootPath even when a whitelist is set", () => {
    const list = [
      repo("web", false, "/workspace/HIS/web"),
      repo("HIS", false, "/workspace/HIS"),
      repo("Other", true),
    ];
    const visible = filterVisibleRepos(list, ["web"], "/workspace\\HIS");
    expect(visible.map((r) => r.name)).toEqual(["web", "HIS"]);
  });
});

describe("resolveVisibleSubrepos", () => {
  const discovered = [
    { name: "Hsp.Win", path: "/workspace/HIS/Hsp.Win" },
    { name: "Nto.His/Nto.His.DrugInOut", path: "/workspace/HIS/Nto.His/Nto.His.DrugInOut" },
    { name: "Nto.His/Nto.His.Term", path: "/workspace/HIS/Nto.His/Nto.His.Term" },
  ];

  // 存量配置兼容：历史配置里的缩写关键字必须勾中真实仓库名，否则下拉会「已选 3 项但没勾上」。
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
