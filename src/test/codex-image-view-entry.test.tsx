import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { CodexStreamView } from "../components/codex-stream/CodexStreamView";
import { codexToolCardExpansion } from "../components/codex-stream/CodexToolCard";
import { createStreamModel, ingestFrameLine } from "../hooks/codexStreamMerge";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// ── 图片查看卡（上游 ThreadItem::ImageView）──────────────────────────────────
// 背景：`view_image` 工具会产生 `{type:"imageView", id, path}` 条目，此前没有
// 渲染器，整条落进「上游未知条目类型」兜底卡——用户只能看到一坨原始 JSON，
// 看不出模型到底看了哪张图。这些用例钉住三点：分发不走兜底、图片经
// read_image_preview 转 dataUrl、加载失败要显式说明而不是留白。

const PROJECT = "H:/Project/Company/HIS";

function imageViewEntry(
  path = "H:/Project/Company/HIS/.nezha/drafts/1793155517069/frames/frame-144.png",
): CodexStreamEntry {
  return {
    kind: "imageView",
    revision: 0,
    item: {
      type: "imageView",
      id: "call_00_hE3o89tPcqfVwkjUv7qK2643",
      path,
    },
  };
}

function renderView(entries: CodexStreamEntry[], projectPath: string | null = PROJECT) {
  return render(
    <I18nProvider>
      <CodexStreamView
        entries={entries}
        usage={null}
        approval={null}
        onApprovalResolved={() => {}}
        running={false}
        projectPath={projectPath ?? undefined}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.setItem("nezha:language", "en");
  invokeMock.mockReset();
});

afterEach(() => {
  codexToolCardExpansion.clear();
  localStorage.clear();
});

describe("codex image view card", () => {
  it("dispatches imageView to the image card instead of the unknown-type fallback", () => {
    invokeMock.mockResolvedValue({ dataUrl: "data:image/png;base64,QQ" });
    renderView([imageViewEntry()]);

    // 兜底卡的「未知条目类型」提示与原始字段名都不该出现
    expect(screen.queryByText(/Unknown entry type/)).toBeNull();
    expect(screen.queryByText(/"imageView"/)).toBeNull();
    // 摘要行用文件名而不是整条路径
    expect(screen.getByRole("button", { name: /frame-144\.png/ })).toBeTruthy();
    expect(screen.getByText("Image")).toBeTruthy();
  });

  it("resolves the local path through read_image_preview and shows the thumbnail", async () => {
    invokeMock.mockResolvedValue({ dataUrl: "data:image/png;base64,QQ" });
    const { container } = renderView([imageViewEntry()]);

    await waitFor(() => {
      expect(container.querySelector(".codex-image-preview")?.getAttribute("src")).toBe(
        "data:image/png;base64,QQ",
      );
    });
    // CSP 只放行 data:/blob:/self，必须带 projectPath 走 IPC 转换而非直用 file://
    expect(invokeMock).toHaveBeenCalledWith("read_image_preview", {
      path: "H:/Project/Company/HIS/.nezha/drafts/1793155517069/frames/frame-144.png",
      projectPath: PROJECT,
    });
  });

  it("states why the image is unavailable instead of leaving a blank card", async () => {
    invokeMock.mockRejectedValue("Path is outside the allowed directory");
    const { container } = renderView([imageViewEntry()]);

    await waitFor(() => {
      expect(screen.getByText("Path is outside the allowed directory")).toBeTruthy();
    });
    expect(container.querySelector('.codex-stream-tool-card[data-status="failed"]')).not.toBeNull();
  });

  it("explains the failure when no project path is available for validation", () => {
    const { container } = renderView([imageViewEntry()], null);
    expect(screen.getByText("Image could not be loaded.")).toBeTruthy();
    // 不能盲目调 IPC：没有项目根就无法做根校验
    expect(invokeMock).not.toHaveBeenCalled();
    expect(container.querySelector('.codex-stream-tool-card[data-status="failed"]')).not.toBeNull();
  });

  it("keeps the path visible so the user can locate the file", () => {
    invokeMock.mockResolvedValue({ dataUrl: "data:image/png;base64,QQ" });
    renderView([imageViewEntry()]);
    expect(
      screen.getByText("H:/Project/Company/HIS/.nezha/drafts/1793155517069/frames/frame-144.png"),
    ).toBeTruthy();
  });
});

// ── 归并层：imageView 必须自成一类，不能落 fallback ─────────────────────────

describe("codexStreamMerge imageView classification", () => {
  it("classifies upstream imageView items as their own entry kind", () => {
    const model = createStreamModel();
    ingestFrameLine(
      model,
      JSON.stringify({
        taskId: "task-1",
        threadId: "thread-1",
        turnId: "turn-1",
        type: "item",
        phase: "completed",
        tsMs: 1000,
        payload: {
          type: "imageView",
          id: "call_00_hE3o89tPcqfVwkjUv7qK2643",
          path: "H:/Project/Company/HIS/.nezha/drafts/frames/frame-144.png",
        },
      }),
    );

    expect(model.entries).toHaveLength(1);
    expect(model.entries[0].kind).toBe("imageView");
    expect(model.byId.get("call_00_hE3o89tPcqfVwkjUv7qK2643")).toBe(model.entries[0]);
    // 完成帧的终点时间照常落到条目上（与其它工具卡一致）
    expect(model.entries[0].endedAtMs).toBe(1000);
  });
});
