import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { YunxiaoWritebackDialog } from "../components/yunxiao/YunxiaoWritebackDialog";

function renderDialog(
  overrides: Partial<Parameters<typeof YunxiaoWritebackDialog>[0]> = {},
) {
  const props: Parameters<typeof YunxiaoWritebackDialog>[0] = {
    serialNumber: "QHDK-30560",
    title: "已收费处方修改医保标识",
    devPreview: "## 修改方案汇总\n\n方案内容。",
    testPreview: "## 影响范围与测试（测试向）\n\n**修改分支** fix/x",
    scorePreview: "## 价值评分\n\n- 优先指数：**31.5**",
    scoreExpanded: true,
    generating: false,
    posting: false,
    error: null,
    warning: null,
    fieldRetrying: false,
    retryScoreValue: null,
    posted: false,
    onDevChange: vi.fn(),
    onTestChange: vi.fn(),
    onScoreChange: vi.fn(),
    onScoreToggle: vi.fn(),
    onRegenerate: vi.fn(),
    onPost: vi.fn(),
    onRetryField: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(
      <I18nProvider>
        <YunxiaoWritebackDialog {...props} />
      </I18nProvider>,
    ),
  };
}

describe("YunxiaoWritebackDialog 三分离（评分独立成评）", () => {
  it("渲染三个预览框：开发向、测试向、评分", () => {
    renderDialog();
    expect(screen.getByDisplayValue(/修改方案汇总/)).toBeTruthy();
    expect(screen.getByDisplayValue(/影响范围与测试/)).toBeTruthy();
    expect(screen.getByDisplayValue(/优先指数/)).toBeTruthy();
    // 测试环境 i18n 跟随系统语言，用评分开关的存在性断言而非具体文案。
    expect(screen.getByTestId("writeback-score-toggle")).toBeTruthy();
  });

  it("评分编辑走 onScoreChange，不污染开发向评论（字段解析链路独立）", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog();
    const scoreBox = screen.getByDisplayValue(/优先指数/);
    await user.clear(scoreBox);
    await user.type(scoreBox, "9");
    expect(props.onScoreChange).toHaveBeenCalled();
    expect(props.onDevChange).not.toHaveBeenCalled();
  });

  it("评分框可折叠：折叠后不渲染 textarea，点击开关触发 onScoreToggle", async () => {
    const user = userEvent.setup();
    const { props } = renderDialog({ scoreExpanded: false });
    expect(screen.queryByDisplayValue(/优先指数/)).toBeNull();
    await user.click(screen.getByTestId("writeback-score-toggle"));
    expect(props.onScoreToggle).toHaveBeenCalledTimes(1);
  });

  it("无评分草稿时开关行带「不写字段」提示（中英文案均含该语义）", () => {
    renderDialog({ scorePreview: "" });
    const toggle = screen.getByTestId("writeback-score-toggle");
    expect(toggle.textContent).toMatch(/无评分草稿|no score draft/);
  });

  it("有评分草稿时不显示空提示", () => {
    renderDialog({ scorePreview: "## 价值评分\n\n- 核心指数：**50**" });
    const toggle = screen.getByTestId("writeback-score-toggle");
    expect(toggle.textContent).not.toMatch(/无评分草稿|no score draft/);
  });
});
