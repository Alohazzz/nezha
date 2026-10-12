import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PlanPreviewPanel } from "../components/yunxiao/plan/PlanPreviewPanel";
import type { Plan, Task } from "../types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const PLAN_MD = `# 方案

## 统筹

总览内容。

## QHDK-A 议题 A

正文 A。
`;

const PREVIEW_HTML = `<!doctype html><html><head><title>方案预览</title></head><body><h1>方案预览页</h1></body></html>`;

function makePlan(): Plan {
  return {
    id: "plan1",
    projectId: "p1",
    name: "医保目录联合方案",
    issues: [{ workitemId: "w1", serialNumber: "QHDK-A", subject: "议题 A" }],
    status: "finalized",
    createdAt: 1,
  };
}

type PanelProps = React.ComponentProps<typeof PlanPreviewPanel>;

function renderPanel(props: Partial<PanelProps> = {}) {
  render(
    <I18nProvider>
      <PlanPreviewPanel
        plan={makePlan()}
        tasks={[] as Task[]}
        projectPath="/workspace/demo"
        onCreateTodos={vi.fn().mockResolvedValue(true)}
        onDeletePlan={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

function mockInvokes({
  markdown = PLAN_MD,
  previewHtml = PREVIEW_HTML,
  mtimes,
}: {
  markdown?: string | Error;
  previewHtml?: string | Error;
  mtimes?: Record<string, number> | Error;
}) {
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === "load_app_settings") return Promise.resolve({});
    if (command === "read_dir_entries") return Promise.resolve([]);
    if (command === "read_file_content") {
      const isHtml = String(args.path).endsWith("preview.html");
      const value = isHtml ? previewHtml : markdown;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
    if (command === "read_file_mtimes") {
      return mtimes instanceof Error
        ? Promise.reject(mtimes)
        : Promise.resolve(
            mtimes ?? {
              [String((args as { paths: string[] }).paths[0])]: 100,
              [String((args as { paths: string[] }).paths[1])]: 100,
            },
          );
    }
    return Promise.resolve(null);
  });
}

describe("PlanPreviewPanel 方案预览 HTML 分支", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nezha:language", "zh");
  });

  afterEach(() => {
    invokeMock.mockReset();
  });

  it("preview.html 存在且不旧于 plan.md：渲染 HTML 预览（沙箱 iframe）", async () => {
    // 缺省 mtimes = { plan.md: 100, preview.html: 100 }，html >= md 成立
    mockInvokes({});
    renderPanel();
    // iframe title 走 i18n「HTML 预览：preview.html」
    const frame = await screen.findByTitle(/HTML 预览：preview\.html/);
    expect(frame).toBeTruthy();
    // allow-modals 放行 am 页面「复制回复」按钮的 execCommand/prompt fallback
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-modals");
  });

  it("preview.html 比 plan.md 旧（agent 改了 md 未重渲）：回落 Markdown 平铺", async () => {
    mockInvokes({
      mtimes: {
        "/workspace/demo/.nezha/plans/plan1/plan.md": 200,
        "/workspace/demo/.nezha/plans/plan1/preview.html": 100,
      },
    });
    renderPanel();
    await screen.findByText("总览内容。");
    expect(screen.queryByTitle(/preview\.html/)).toBeNull();
  });

  it("preview.html 缺失（历史方案 / 渲染失败被跳过）：回落 Markdown 平铺", async () => {
    mockInvokes({ previewHtml: new Error("File does not exist") });
    renderPanel();
    await screen.findByText("总览内容。");
    expect(screen.queryByTitle(/preview\.html/)).toBeNull();
  });

  it("mtime 读取失败（不可信竞态）：回落 Markdown 平铺", async () => {
    mockInvokes({ mtimes: new Error("stat failed") });
    renderPanel();
    await screen.findByText("总览内容。");
    expect(screen.queryByTitle(/preview\.html/)).toBeNull();
  });

  it("preview.html 为空白内容：视为无预览页，回落 Markdown 平铺", async () => {
    mockInvokes({ previewHtml: "   \n  " });
    renderPanel();
    await screen.findByText("总览内容。");
    expect(screen.queryByTitle(/preview\.html/)).toBeNull();
  });
});
