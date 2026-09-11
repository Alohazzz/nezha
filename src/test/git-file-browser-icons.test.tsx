import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { GitFileBrowser } from "../components/git-view/GitFileBrowser";

/** Git 变更 / 提交历史列表与文件浏览器共用 Material Icon Theme 图标，
 *  不允许再退回 lucide 的通用 File / Folder 图标。 */
function renderBrowser(
  entries: Array<{
    path: string;
    status: string;
    staged?: boolean;
    additions?: number;
    deletions?: number;
  }>,
  mode: "tree" | "list" = "tree",
  showStats = false,
) {
  const { container } = render(
    <I18nProvider>
      <GitFileBrowser entries={entries} mode={mode} showStats={showStats} />
    </I18nProvider>,
  );
  return container;
}

const statText = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("span"))
    .filter((el) => el.children.length === 0 && /^[+-]\d+$/.test(el.textContent ?? ""))
    .map((el) => el.textContent ?? "")
    .sort();

describe("GitFileBrowser uses Material Icon Theme icons", () => {
  it("renders theme SVGs for known extensions via the list mode", () => {
    const container = renderBrowser(
      [
        { path: "src/App.tsx", status: "M" },
        { path: "src/main.rs", status: "M" },
      ],
      "list",
    );
    const icons = Array.from(container.querySelectorAll<HTMLImageElement>("img.file-icon"));

    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon.getAttribute("src")).toMatch(/\.svg(\?.*)?$/);
    }
    expect(icons[0].getAttribute("src")).toContain("react_ts");
    expect(icons[1].getAttribute("src")).toContain("rust");
  });

  it("projects map to the visualstudio icon and unknown files to the generic file icon", () => {
    const container = renderBrowser(
      [
        { path: "Nto.His.Order.UI.csproj", status: "M" },
        { path: "Nto.Emsr", status: "M" },
      ],
      "list",
    );
    const icons = Array.from(container.querySelectorAll<HTMLImageElement>("img.file-icon"));

    expect(icons[0].getAttribute("src")).toContain("visualstudio");
    expect(icons[1].getAttribute("src")).toContain("file");
  });

  it("renders a folder icon for directory rows in tree mode", () => {
    const container = renderBrowser([{ path: "src/App.tsx", status: "M" }], "tree");
    const icons = Array.from(container.querySelectorAll<HTMLImageElement>("img.file-icon"));

    expect(icons).toHaveLength(2);
    // 目录行在前，文件行在后；目录图标同样来自主题 SVG。
    expect(icons[0].getAttribute("src")).toMatch(/folder[^/]*\.svg(\?.*)?$/);
    expect(container.textContent).toContain("src");
    expect(container.textContent).toContain("App.tsx");
  });
});

describe("GitFileBrowser shows per-file line stats when requested", () => {
  const entries = [
    { path: "src/App.tsx", status: "M", additions: 5, deletions: 13 },
    { path: "docs/readme.md", status: "?", additions: 321, deletions: 0 },
  ];

  it("renders +additions/-deletions in list mode", () => {
    const container = renderBrowser(entries, "list", true);
    expect(statText(container)).toEqual(["-0", "-13", "+321", "+5"].sort());
  });

  it("renders stats in tree mode and rolls them up onto directories", () => {
    const container = renderBrowser(entries, "tree", true);
    // 目录 src 汇总 5/13、docs 汇总 321/0；每个文件自身各一份 → 8 个统计片段。
    expect(statText(container)).toEqual(
      ["-0", "-0", "-13", "-13", "+321", "+321", "+5", "+5"].sort(),
    );
  });

  it("hides stats when showStats is off", () => {
    const container = renderBrowser(entries, "list", false);
    expect(statText(container)).toEqual([]);
  });
});
