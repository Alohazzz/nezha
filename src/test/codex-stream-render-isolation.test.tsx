import { memo } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { CodexStreamEntry } from "../hooks/codexStreamMerge";
import type { CodexUserMessageItem } from "../types";

// ── 流帧期间 composer 的重渲染隔离 ──────────────────────────────────────────
// 症状：structured 任务运行中往 composer 打字，文字回显延迟、快打时重复录入。
// 接缝：CodexStreamView 每次流 flush（entries 数组换引用）都重渲染整棵视图；
// CodexComposer 若无 memo，跟着每帧重渲染，与 keystroke 的受控回显争抢主线程。
// 判定：把 CodexComposer mock 成渲染计数替身（同样包 memo，等价真组件的
// memo 语义），entries 增量帧（换引用、内容追加）后替身的渲染次数应为 0——
// props 全部引用稳定时 memo 生效即整体跳过。

const { composerRenderSpy } = vi.hoisted(() => ({
  composerRenderSpy: vi.fn(),
}));

vi.mock("../components/codex-stream/CodexComposer", () => ({
  // 替身必须与真组件一样包 memo：mock 裸函数组件会绕过 memo 语义，
  // 测的是替身而不是隔离行为。
  CodexComposer: memo((props: Record<string, unknown>) => {
    composerRenderSpy();
    return (
      <textarea
        aria-label="composer-stub"
        data-testid="composer-stub"
        value=""
        readOnly
        data-props-onsubmit={typeof props.onSubmit === "function" ? "1" : "0"}
      />
    );
  }),
}));

import { CodexStreamView } from "../components/codex-stream/CodexStreamView";

function userEntry(id: string): CodexStreamEntry {
  return {
    kind: "userMessage",
    revision: 0,
    startedAtMs: null,
    endedAtMs: null,
    item: {
      type: "userMessage",
      id,
      content: [{ type: "text", text: id }],
    } satisfies CodexUserMessageItem,
  };
}

const BASE_PROPS = {
  usage: null,
  approval: null,
  onApprovalResolved: () => {},
  running: true,
  statusText: null,
  onComposerSubmit: () => {},
  onImageToast: () => {},
  onOpenGitChanges: () => {},
  onOpenLink: () => {},
  onSetStructuredModel: () => {},
  onBuiltinAction: () => {},
  showModelBadge: true,
  model: "gpt-5",
  reasoningEffort: "max",
};

function renderView(entries: CodexStreamEntry[]) {
  return render(
    <I18nProvider>
      <CodexStreamView {...BASE_PROPS} entries={entries} />
    </I18nProvider>,
  );
}

describe("CodexStreamView 流帧渲染隔离", () => {
  it("entries 增量帧（换引用、内容追加）不应重渲染 CodexComposer", () => {
    const initial = [userEntry("u1")];
    const view = renderView(initial);
    const rendersAfterMount = composerRenderSpy.mock.calls.length;
    expect(rendersAfterMount).toBeGreaterThan(0);

    // 模拟 5 个流 flush：entries 换引用、追加条目。composer 的 props 全部
    // 引用稳定（BASE_PROPS 复用同一对象、字符串值相等），memo 生效即 0 次。
    for (let i = 2; i <= 6; i++) {
      view.rerender(
        <I18nProvider>
          <CodexStreamView {...BASE_PROPS} entries={[...initial, userEntry(`u${i}`)]} />
        </I18nProvider>,
      );
    }

    const rendersDuringFrames =
      composerRenderSpy.mock.calls.length - rendersAfterMount;
    expect(rendersDuringFrames).toBe(0);
  });
});
