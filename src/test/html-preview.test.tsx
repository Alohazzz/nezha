import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HtmlPreviewPane } from "../components/file-viewer/HtmlPreviewPane";
import { I18nProvider } from "../i18n";
import { isHtmlFileName } from "../utils";

function renderPane(html: string) {
  return render(
    <I18nProvider>
      <HtmlPreviewPane html={html} fileName="report.html" />
    </I18nProvider>,
  );
}

function frameOf(container: HTMLElement) {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("iframe not rendered");
  return frame;
}

describe("isHtmlFileName", () => {
  it("matches .html and .htm case-insensitively", () => {
    expect(isHtmlFileName("report.html")).toBe(true);
    expect(isHtmlFileName("REPORT.HTM")).toBe(true);
  });

  it("does not match other extensions", () => {
    expect(isHtmlFileName("index.tsx")).toBe(false);
    expect(isHtmlFileName("notes.md")).toBe(false);
  });

  it("matches a bare name the same way isMarkdownFileName does", () => {
    // 既有约定：`split(".").pop()` 对无扩展名文件名返回整个名字，
    // 所以裸 `html` 也匹配（与 isMarkdownFileName("md") === true 一致）。
    expect(isHtmlFileName("html")).toBe(true);
  });
});

describe("HtmlPreviewPane", () => {
  it("renders the document through a srcdoc iframe", () => {
    const { container } = renderPane("<p>HELLO</p>");
    expect(frameOf(container).getAttribute("srcdoc")).toBe("<p>HELLO</p>");
  });

  it("keeps scripts working while withholding same-origin access to the host", () => {
    // `allow-scripts` 让被预览文档的脚本可运行；绝不能再给 `allow-same-origin`，
    // 否则子文档会获得与宿主相同的源，可直接读写应用 DOM 与 localStorage。
    const { container } = renderPane("<script>1</script>");
    const sandbox = frameOf(container).getAttribute("sandbox") ?? "";

    expect(sandbox.split(/\s+/)).toContain("allow-scripts");
    expect(sandbox.split(/\s+/)).not.toContain("allow-same-origin");
  });

  it("warns only when the document references resources srcdoc cannot load", () => {
    const { container: withRefs } = renderPane('<img src="./chart.png">');
    expect(screen.getByRole("note")).toBeTruthy();

    const { container: inline } = renderPane('<img src="data:image/png;base64,AAAA">');
    expect(inline.querySelector(".html-preview-notice")).toBeNull();
    expect(withRefs.querySelector(".html-preview-notice")).not.toBeNull();
  });
});
