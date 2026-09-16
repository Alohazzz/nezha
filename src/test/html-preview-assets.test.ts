import { describe, expect, it } from "vitest";
import {
  isInsideProject,
  normalizePath,
  renderCssWithInlineAssets,
  renderHtmlWithInlineAssets,
  resolveAssetPath,
  scanCssAssets,
  scanHtmlAssets,
} from "../utils/htmlPreview";

const PROJECT = "/workspace/ICUCIS";
const LESSON = `${PROJECT}/lessons/0003-observe-business.html`;

describe("normalizePath", () => {
  it("collapses . and .. segments", () => {
    expect(normalizePath("/a/b/../c/./d")).toBe("/a/c/d");
    expect(normalizePath("C:\\a\\b\\..\\c")).toBe("C:/a/c");
  });

  it("rejects traversal past a filesystem root", () => {
    expect(normalizePath("/../etc/passwd")).toBeNull();
    expect(normalizePath("C:/../../x")).toBeNull();
  });
});

describe("resolveAssetPath", () => {
  it("resolves sibling-relative references against the file's directory", () => {
    expect(resolveAssetPath("../assets/course.css", LESSON, PROJECT)).toBe(
      `${PROJECT}/assets/course.css`,
    );
    expect(resolveAssetPath("./0002-intake.html", LESSON, PROJECT)).toBe(
      `${PROJECT}/lessons/0002-intake.html`,
    );
  });

  it("treats a leading slash as project-root relative", () => {
    expect(resolveAssetPath("/assets/course.css", LESSON, PROJECT)).toBe(
      `${PROJECT}/assets/course.css`,
    );
  });

  it("decodes percent-escapes and ignores query / fragment", () => {
    expect(resolveAssetPath("../重症%20护理记录单.pdf", LESSON, PROJECT)).toBe(
      `${PROJECT}/重症 护理记录单.pdf`,
    );
    expect(resolveAssetPath("../assets/course.css?v=2#x", LESSON, PROJECT)).toBe(
      `${PROJECT}/assets/course.css`,
    );
  });

  it("refuses refs that are not local files", () => {
    expect(resolveAssetPath("https://fonts.googleapis.com/css2?family=x", LESSON, PROJECT)).toBeNull();
    expect(resolveAssetPath("//cdn.example.com/a.js", LESSON, PROJECT)).toBeNull();
    expect(resolveAssetPath("data:image/png;base64,AAAA", LESSON, PROJECT)).toBeNull();
    expect(resolveAssetPath("#section", LESSON, PROJECT)).toBeNull();
  });

  it("refuses to escape the project root", () => {
    // 关键安全断言：预览被渲染在 opaque origin 的沙箱 iframe 里，但它读到的内容
    // 仍必须限制在项目内，不能靠 `../../` 把宿主任意文件读进 iframe。
    expect(resolveAssetPath("../../../../etc/passwd", LESSON, PROJECT)).toBeNull();
    expect(resolveAssetPath("../../../secrets.txt", LESSON, PROJECT)).toBeNull();
  });
});

describe("isInsideProject", () => {
  it("matches case-insensitively (Windows drive letters)", () => {
    expect(isInsideProject("C:/Proj/a.css", "c:/proj")).toBe(true);
    expect(isInsideProject("C:/other/a.css", "C:/proj")).toBe(false);
  });

  it("does not treat a shared prefix as containment", () => {
    expect(isInsideProject("/workspace/ICUCIS-extra/a.css", "/workspace/ICUCIS")).toBe(false);
  });
});

describe("scanHtmlAssets", () => {
  it("finds stylesheets, scripts and images", () => {
    const { refs, external } = scanHtmlAssets(
      `<link rel="stylesheet" href="../assets/course.css">
       <script defer src="../assets/quiz.js"></script>
       <img src="./img/a.png">
       <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">`,
      LESSON,
      PROJECT,
    );

    expect(refs.map((r) => [r.kind, r.path])).toEqual([
      ["stylesheet", `${PROJECT}/assets/course.css`],
      ["script", `${PROJECT}/assets/quiz.js`],
      ["image", `${PROJECT}/lessons/img/a.png`],
    ]);
    expect(external).toEqual(["https://fonts.googleapis.com/css2?family=X"]);
  });

  it("ignores non-stylesheet links and inline references", () => {
    const { refs, external } = scanHtmlAssets(
      `<link rel="icon" href="../assets/favicon.ico">
       <a href="../reference/glossary.html">术语表</a>
       <img src="data:image/png;base64,AAAA">`,
      LESSON,
      PROJECT,
    );

    expect(refs).toEqual([]);
    expect(external).toEqual([]);
  });

  it("does not scan inside the bodies of script and style tags", () => {
    // 脚本里的模板字符串常含 `<img src="...">` 之类字面量，误当作真实引用会去读
    // 一个并不存在的文件。
    const { refs } = scanHtmlAssets(
      `<script>const tpl = '<img src="./ghost.png">';</script>`,
      LESSON,
      PROJECT,
    );

    expect(refs).toEqual([]);
  });

  it("does not read tags out of comments", () => {
    const { refs } = scanHtmlAssets(
      `<!-- <link rel="stylesheet" href="../assets/old.css"> -->`,
      LESSON,
      PROJECT,
    );

    expect(refs).toEqual([]);
  });

  it("collects CSS url() / @import of inline style blocks", () => {
    const { refs } = scanHtmlAssets(
      `<style>@import "../assets/print.css"; body { background: url('./img/bg.png'); }</style>`,
      LESSON,
      PROJECT,
    );

    expect(refs.map((r) => [r.kind, r.path])).toEqual([
      ["stylesheet", `${PROJECT}/assets/print.css`],
      ["image", `${PROJECT}/lessons/img/bg.png`],
    ]);
  });
});

describe("scanCssAssets", () => {
  it("handles quoted and bare url() forms", () => {
    const { refs } = scanCssAssets(
      `a { background: url("x.png"); } b { background: url( y.png ); } c { background: url('z.png'); }`,
      `${PROJECT}/assets/course.css`,
      PROJECT,
    );

    expect(refs.map((r) => r.path).sort()).toEqual([
      `${PROJECT}/assets/x.png`,
      `${PROJECT}/assets/y.png`,
      `${PROJECT}/assets/z.png`,
    ]);
  });

  it("skips data: urls and remote fonts", () => {
    const { refs, external } = scanCssAssets(
      `@font-face { src: url(data:font/woff2;base64,AA); }
       @font-face { src: url(https://fonts.gstatic.com/f.woff2); }`,
      `${PROJECT}/assets/course.css`,
      PROJECT,
    );

    expect(refs).toEqual([]);
    expect(external).toEqual(["https://fonts.gstatic.com/f.woff2"]);
  });
});

describe("renderHtmlWithInlineAssets", () => {
  const lookup = (path: string) =>
    ({
      [`${PROJECT}/assets/course.css`]: ".wrap{max-width:40rem}",
      [`${PROJECT}/assets/quiz.js`]: "document.title='quiz';",
      [`${PROJECT}/lessons/img/a.png`]: "data:image/png;base64,AAAA",
    })[path] ?? null;

  it("inlines the stylesheet, script and image", () => {
    const { html, unresolved } = renderHtmlWithInlineAssets(
      `<link rel="stylesheet" href="../assets/course.css">
       <script defer src="../assets/quiz.js"></script>
       <img src="./img/a.png">
       <img src="data:image/png;base64,ZZZZ">
       <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">`,
      LESSON,
      lookup,
      PROJECT,
    );

    expect(html).toContain("<style data-nezha-inlined-from=\"../assets/course.css\">");
    expect(html).toContain(".wrap{max-width:40rem}");
    expect(html).toContain("<script>\ndocument.title='quiz';\n</script>");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    // 已有 data URL 原样保留；远程样式表保持外链并计入 unresolved 之外（由调用方按 external 提示）。
    expect(html).toContain('src="data:image/png;base64,ZZZZ"');
    expect(html).toContain('href="https://fonts.googleapis.com/css2?family=X"');
    // 原来的外链 <link> 必须整段消失，而不是与内联 <style> 并存。
    expect(html).not.toContain('<link rel="stylesheet" href="../assets/course.css">');
    expect(unresolved).toEqual([]);
  });

  it("leaves unresolvable refs in place and reports them", () => {
    const { html, unresolved } = renderHtmlWithInlineAssets(
      `<img src="./img/missing.png">`,
      LESSON,
      lookup,
      PROJECT,
    );

    expect(html).toContain('src="./img/missing.png"');
    expect(unresolved).toEqual(["./img/missing.png"]);
  });

  it("refuses to inline a body containing the closing tag", () => {
    // 若朴素内联，`</script>` 会把文档从中间截断，预览直接报废。
    const { html, unresolved } = renderHtmlWithInlineAssets(
      `<script src="../assets/evil.js"></script>`,
      LESSON,
      (path) => (path.endsWith("evil.js") ? "var x = '</script>';" : null),
      PROJECT,
    );

    expect(html).toContain('<script src="../assets/evil.js"></script>');
    expect(html).not.toContain("var x =");
    expect(unresolved).toEqual(["../assets/evil.js"]);
  });

  it("appends the data url without dropping the tag's other attributes", () => {
    const { html } = renderHtmlWithInlineAssets(
      `<img class="chart" alt="图" src="./img/a.png" width="10">`,
      LESSON,
      lookup,
      PROJECT,
    );

    expect(html).toBe(
      `<img class="chart" alt="图" src="data:image/png;base64,AAAA" width="10">`,
    );
  });
});

describe("renderCssWithInlineAssets", () => {
  it("inlines url() targets relative to the css file", () => {
    const { css, unresolved } = renderCssWithInlineAssets(
      `body { background: url("./img/bg.png"); }`,
      `${PROJECT}/assets/course.css`,
      (path) => (path === `${PROJECT}/assets/img/bg.png` ? "data:image/png;base64,BBBB" : null),
      PROJECT,
    );

    expect(css).toContain('url("data:image/png;base64,BBBB")');
    expect(unresolved).toEqual([]);
  });

  it("expands @import into the imported stylesheet", () => {
    const { css } = renderCssWithInlineAssets(
      `@import "../assets/print.css";`,
      `${PROJECT}/assets/course.css`,
      (path) => (path === `${PROJECT}/assets/print.css` ? "@media print { .x { color: red } }" : null),
      PROJECT,
    );

    expect(css).toContain("@media print");
    expect(css).not.toContain("@import");
  });

  it("keeps unresolvable url() untouched and reports it", () => {
    const { css, unresolved } = renderCssWithInlineAssets(
      `body { background: url(missing.png); }`,
      `${PROJECT}/assets/course.css`,
      () => null,
      PROJECT,
    );

    expect(css).toContain("url(missing.png)");
    expect(unresolved).toEqual(["missing.png"]);
  });
});
