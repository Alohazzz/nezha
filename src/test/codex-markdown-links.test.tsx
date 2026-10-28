import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexMarkdown } from "../components/codex-stream/CodexMarkdown";
import {
  classifyMarkdownLink,
  draftDocumentPathCandidates,
  linkifyBareDraftNames,
} from "../components/codex-stream/draftDocuments";

// ── classifyMarkdownLink：三类目标 ────────────────────────────────────────────

describe("classifyMarkdownLink", () => {
  it("项目内相对路径（含沉淀文档、反斜杠路径）→ projectPath", () => {
    expect(classifyMarkdownLink(".nezha/drafts/t1/discussion.md")).toEqual({
      kind: "projectPath",
      href: ".nezha/drafts/t1/discussion.md",
      fileName: "discussion.md",
    });
    expect(classifyMarkdownLink("TEST-PLAN.md")).toEqual({
      kind: "projectPath",
      href: "TEST-PLAN.md",
      fileName: "TEST-PLAN.md",
    });
    expect(classifyMarkdownLink("src/patientRegistry.ts")).toMatchObject({
      kind: "projectPath",
      fileName: "patientRegistry.ts",
    });
    expect(classifyMarkdownLink("src\\app\\main.tsx")).toMatchObject({
      kind: "projectPath",
      fileName: "main.tsx",
    });
  });

  it("http/https/mailto → external", () => {
    expect(classifyMarkdownLink("https://example.com/a?q=1")).toEqual({
      kind: "external",
      href: "https://example.com/a?q=1",
    });
    expect(classifyMarkdownLink("mailto:a@b.c")).toEqual({ kind: "external", href: "mailto:a@b.c" });
  });

  it("项目内绝对路径（盘符）→ projectPath，:line 行号后缀被剥掉", () => {
    expect(classifyMarkdownLink("H:/Project/nezha-plan-test-project/TEST-PLAN.md:1")).toEqual({
      kind: "projectPath",
      href: "H:/Project/nezha-plan-test-project/TEST-PLAN.md",
      fileName: "TEST-PLAN.md",
    });
    expect(classifyMarkdownLink("C:\\repo\\src\\app.tsx")).toMatchObject({
      kind: "projectPath",
      fileName: "app.tsx",
    });
  });

  it("锚点 / file 等伪协议 / ~ → unsupported", () => {
    expect(classifyMarkdownLink("#section")).toEqual({ kind: "unsupported" });
    expect(classifyMarkdownLink("~/notes/a.md")).toEqual({ kind: "unsupported" });
    expect(classifyMarkdownLink("javascript:alert(1)")).toEqual({ kind: "unsupported" });
    expect(classifyMarkdownLink("file:///etc/passwd")).toEqual({ kind: "unsupported" });
    expect(classifyMarkdownLink("vscode://file/C:/repo/a.ts")).toEqual({ kind: "unsupported" });
  });

  it("以 / 开头的路径仍按项目内处理（read_file_content 做沙箱校验）", () => {
    expect(classifyMarkdownLink("/docs/architecture.md")).toMatchObject({
      kind: "projectPath",
      fileName: "architecture.md",
    });
  });
});

// ── linkifyBareDraftNames：裸文件名转链接 ─────────────────────────────────────

describe("linkifyBareDraftNames", () => {
  it("正文中的裸 discussion.md / knowledge.json 被包成 <a>", () => {
    const out = linkifyBareDraftNames("<p>产品已写入 discussion.md 和 knowledge.json。</p>");
    expect(out).toContain('<a href="discussion.md" data-draft-link="1">discussion.md</a>');
    expect(out).toContain('<a href="knowledge.json" data-draft-link="1">knowledge.json</a>');
  });

  it("已是链接语法的内容不再二次包裹（锚文本 / href 属性内不加 <a>）", () => {
    const inHtml = '<a href=".nezha/drafts/t1/discussion.md">discussion.md</a>';
    // 锚文本前导是 `>`、href 属性值内前导是 `/`，都在排除边界里——已渲染
    // 链接若被再包一层会产生非法嵌套 <a>，点击委托会命中内层假 href。
    expect(linkifyBareDraftNames(inHtml)).toBeNull();
  });

  it("行尾 / 标点紧邻的裸文件名也能转换", () => {
    expect(linkifyBareDraftNames("<p>已写入 discussion.md</p>")).toContain(
      '<a href="discussion.md"',
    );
    expect(linkifyBareDraftNames("（见 knowledge.json）")).toContain('<a href="knowledge.json"');
  });

  it("标签紧邻的文件名保守跳过（前导 > 无法与已渲染链接的锚文本区分）", () => {
    expect(linkifyBareDraftNames("<strong>knowledge.json</strong>")).toBeNull();
  });

  it("路径片段 / 带扩展名后缀 / 连字符前缀不误转", () => {
    expect(linkifyBareDraftNames(".nezha/drafts/t1/discussion.md")).toBeNull();
    expect(linkifyBareDraftNames("discussion.md.bak")).toBeNull();
    expect(linkifyBareDraftNames("not-discussion.md")).toBeNull();
  });

  it("无命中返回 null（调用方沿用原始 HTML）", () => {
    expect(linkifyBareDraftNames("<p>普通正文</p>")).toBeNull();
  });
});

// ── draftDocumentPathCandidates：路径候选 ────────────────────────────────────

describe("draftDocumentPathCandidates", () => {
  const base = { projectPath: "/repo", worktreePath: null, taskId: "t1" };

  it("沉淀白名单裸文件名优先回落 .nezha/drafts/<taskId>/，再试项目根同名文件", () => {
    expect(draftDocumentPathCandidates({ ...base, href: "discussion.md" })).toEqual([
      "/repo/.nezha/drafts/t1/discussion.md",
      "/repo/discussion.md",
    ]);
  });

  it("非白名单裸文件名直接按项目根解析", () => {
    expect(draftDocumentPathCandidates({ ...base, href: "TEST-PLAN.md" })).toEqual([
      "/repo/TEST-PLAN.md",
    ]);
  });

  it("带路径的 href 相对项目根解析，worktree 存在时追加第二候选", () => {
    expect(
      draftDocumentPathCandidates({
        ...base,
        href: "src/patientRegistry.ts",
        worktreePath: "/repo/.nezha/worktrees/wt1",
      }),
    ).toEqual(["/repo/src/patientRegistry.ts", "/repo/.nezha/worktrees/wt1/src/patientRegistry.ts"]);
  });

  it("剥掉开头的 / 与 ./，worktree 与项目根相同时候选去重", () => {
    expect(
      draftDocumentPathCandidates({
        ...base,
        href: "./docs/readme.md",
        worktreePath: "/repo",
      }),
    ).toEqual(["/repo/docs/readme.md"]);
  });

  it("项目内绝对路径剥掉盘符前缀后按相对路径解析", () => {
    expect(
      draftDocumentPathCandidates({
        projectPath: "H:/Project/repo",
        worktreePath: null,
        taskId: "t1",
        href: "H:/Project/repo/TEST-PLAN.md",
      }),
    ).toEqual(["H:/Project/repo/TEST-PLAN.md"]);
  });

  it("绝对路径带 worktree 前缀时剥 worktree，也在项目根试一次", () => {
    const winBase = { projectPath: "H:/Project/repo", taskId: "t1" };
    expect(
      draftDocumentPathCandidates({
        ...winBase,
        href: "H:/Project/repo/src/app.ts",
        worktreePath: "H:/Project/repo/.nezha/worktrees/wt1",
      }),
    ).toEqual(["H:/Project/repo/src/app.ts"]);
    expect(
      draftDocumentPathCandidates({
        ...winBase,
        href: "H:/Project/repo/.nezha/worktrees/wt1/src/app.ts",
        worktreePath: "H:/Project/repo/.nezha/worktrees/wt1",
      }),
    ).toEqual(["H:/Project/repo/.nezha/worktrees/wt1/src/app.ts"]);
  });

  it("项目外的绝对路径 → 空候选（toast 找不到）", () => {
    expect(
      draftDocumentPathCandidates({ ...base, href: "H:/Elsewhere/notes/a.md" }),
    ).toEqual([]);
  });
});

// ── CodexMarkdown：点击委托 ──────────────────────────────────────────────────

describe("CodexMarkdown onOpenLink", () => {
  it("点击 markdown 链接 → preventDefault + onOpenLink(href)", () => {
    const onOpenLink = vi.fn();
    render(
      <I18nProvider>
        <CodexMarkdown
          text="[discussion.md](.nezha/drafts/t1/discussion.md)"
          onOpenLink={onOpenLink}
        />
      </I18nProvider>,
    );
    const anchor = screen.getByText("discussion.md");
    fireEvent.click(anchor);
    expect(onOpenLink).toHaveBeenCalledWith(".nezha/drafts/t1/discussion.md");
  });

  it("裸文件名在传 onOpenLink 时被转成链接并可点击", () => {
    const onOpenLink = vi.fn();
    render(
      <I18nProvider>
        <CodexMarkdown text="产品已写入 knowledge.json。" onOpenLink={onOpenLink} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByText("knowledge.json"));
    expect(onOpenLink).toHaveBeenCalledWith("knowledge.json");
  });

  it("不传 onOpenLink 时裸文件名保持纯文本", () => {
    render(
      <I18nProvider>
        <CodexMarkdown text="产品已写入 knowledge.json。" />
      </I18nProvider>,
    );
    expect(document.querySelector("a")).toBeNull();
    expect(screen.getByText(/knowledge\.json/)).toBeTruthy();
  });
});
