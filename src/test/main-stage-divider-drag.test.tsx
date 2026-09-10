import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { useProjectPanels } from "../hooks/useProjectPanels";

// 场景：多项目驻留挂载时，DOM 里存在多个 id="nezha-main-stage"（非激活项目 display:none）。
// 拖拽 handler 若用 document.getElementById 全局查找，会拿到隐藏 stage（width=0），
// (clientX-startX)/0 = ±Infinity → clamp 到 0.8/0.2 极值，分割条"固定成一定比例"。
function Harness() {
  const { mainStageRatio, handleMainStageResizeStart } = useProjectPanels();
  return (
    <div>
      {/* 先挂载的隐藏项目：display:none → getBoundingClientRect 宽度为 0 */}
      <div id="nezha-main-stage" data-hidden style={{ display: "none" }} />
      {/* 激活项目的中央舞台（真实拖拽目标） */}
      <div id="nezha-main-stage" data-active style={{ width: 1000 }}>
        <div
          style={{ width: 1000, height: 20 }}
          onPointerDown={handleMainStageResizeStart}
          data-testid="divider"
        />
      </div>
      <div data-testid="ratio">{mainStageRatio.toFixed(3)}</div>
    </div>
  );
}

describe("main stage divider drag", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom 的 getBoundingClientRect 恒为 0；按元素区分：隐藏 stage 0 宽，活动 stage 1000 宽
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = this.hasAttribute("data-hidden") ? 0 : 1000;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: 0,
          right: width,
          width,
          height: 20,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
  });

  it("拖拽按真实舞台宽度平滑跟随，即使 DOM 前面存在同 id 的隐藏 stage", () => {
    render(<Harness />);
    const divider = screen.getByTestId("divider");

    fireEvent.pointerDown(divider, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 600, pointerId: 1 });

    // 0.5 + 100/1000 = 0.6；若误用隐藏 stage（宽 0）会 clamp 到 0.8
    expect(screen.getByTestId("ratio").textContent).toBe("0.600");
  });
});
