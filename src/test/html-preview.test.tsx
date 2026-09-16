import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HtmlPreviewPane } from "../components/file-viewer/HtmlPreviewPane";
import { I18nProvider } from "../i18n";
import { isHtmlFileName } from "../utils";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function renderPane(html: string, props: { filePath?: string; projectPath?: string } = {}) {
  return render(
    <I18nProvider>
      <HtmlPreviewPane html={html} fileName="report.html" {...props} />
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
    // 无 filePath / projectPath 时退回纯启发式判断（不做任何读取），
    // 这也是未传新 props 的老调用方行为。
    const { container: withRefs } = renderPane('<img src="./chart.png">');
    expect(screen.getByRole("note")).toBeTruthy();

    const { container: inline } = renderPane('<img src="data:image/png;base64,AAAA">');
    expect(inline.querySelector(".html-preview-notice")).toBeNull();
    expect(withRefs.querySelector(".html-preview-notice")).not.toBeNull();
  });
});

describe("HtmlPreviewPane 资源内联", () => {
  const PROJECT = "C:/proj";
  const FILE = `${PROJECT}/lessons/0003.html`;

  beforeEach(() => {
    localStorage.setItem("nezha:language", "zh");
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("inlines project-local stylesheets and scripts before rendering", async () => {
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "read_file_content" && args.path === `${PROJECT}/assets/course.css`) {
        return Promise.resolve(".wrap{max-width:40rem}");
      }
      if (command === "read_file_content" && args.path === `${PROJECT}/assets/quiz.js`) {
        return Promise.resolve("document.title='ok';");
      }
      return Promise.reject(new Error("not found"));
    });

    const { container } = renderPane(
      `<link rel="stylesheet" href="../assets/course.css">
       <script defer src="../assets/quiz.js"></script>`,
      { filePath: FILE, projectPath: PROJECT },
    );

    await waitFor(() => {
      const srcdoc = frameOf(container).getAttribute("srcdoc") ?? "";
      expect(srcdoc).toContain(".wrap{max-width:40rem}");
      expect(srcdoc).toContain("document.title='ok';");
    });

    // 全部读到，不该有「未能加载」提示。
    expect(screen.queryByRole("note")).toBeNull();
    // 读取必须带上 projectPath，Rust 侧才能做根校验。
    expect(invokeMock).toHaveBeenCalledWith("read_file_content", {
      path: `${PROJECT}/assets/course.css`,
      projectPath: PROJECT,
    });
  });

  it("reads images through read_image_preview as data urls", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "read_image_preview") return Promise.resolve({ dataUrl: "data:image/png;base64,QQ" });
      return Promise.reject(new Error("not found"));
    });

    const { container } = renderPane(`<img src="./img/a.png">`, {
      filePath: FILE,
      projectPath: PROJECT,
    });

    await waitFor(() => {
      expect(frameOf(container).getAttribute("srcdoc")).toContain('src="data:image/png;base64,QQ"');
    });
  });

  it("renders the document even when an asset is missing, and says so", async () => {
    invokeMock.mockRejectedValue(new Error("missing"));

    const { container } = renderPane(
      `<p>正文</p><link rel="stylesheet" href="../assets/nope.css">`,
      { filePath: FILE, projectPath: PROJECT },
    );

    await waitFor(() => expect(screen.getByRole("note")).toBeTruthy());
    // 样式没拿到也不能把整页变成空白 —— 正文仍然渲染。
    expect(frameOf(container).getAttribute("srcdoc")).toContain("正文");
  });

  it("does not read anything for refs outside the project", async () => {
    invokeMock.mockRejectedValue(new Error("should not be called"));

    const { container } = renderPane(`<img src="../../../../etc/passwd">`, {
      filePath: FILE,
      projectPath: PROJECT,
    });

    // 逃逸引用既不被解析也不被提示为「本地缺失」，且不会发出读取请求。
    expect(invokeMock).not.toHaveBeenCalled();
    expect(frameOf(container).getAttribute("srcdoc")).toContain("../../../../etc/passwd");
  });

  it("flags CDN references, which the app CSP blocks", async () => {
    invokeMock.mockRejectedValue(new Error("unused"));

    renderPane(`<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">`, {
      filePath: FILE,
      projectPath: PROJECT,
    });

    await waitFor(() => expect(screen.getByRole("note")).toBeTruthy());
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
