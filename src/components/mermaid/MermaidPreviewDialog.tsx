import { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { useI18n } from "../../i18n";

// 对照 ZCode packages/ui/src/components/ai-elements/diagram-preview-dialog.tsx
// 的交互集：滚轮缩放 / 拖拽平移 / fit 适应窗口 / 按钮缩放，缩放范围 0.25×-4×。
// 样式走 styles/mermaid.css 的 .nezha-mermaid-preview-* 类。

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

interface MermaidPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  svg: string | null;
}

export function MermaidPreviewDialog({ open, onOpenChange, svg }: MermaidPreviewDialogProps) {
  const { t } = useI18n();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // 拖拽期间的可变状态走 ref，pointermove 高频回调不触发重渲染（AGENTS.md 性能规范）。
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const resetView = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);  const fitToWindow = useCallback(() => {
    const viewport = viewportRef.current;
    const svgEl = viewport?.querySelector("svg");
    if (!viewport || !svgEl) {
      resetView();
      return;
    }
    const vb = svgEl.getAttribute("viewBox");
    let naturalWidth = svgEl.clientWidth;
    let naturalHeight = svgEl.clientHeight;
    if (vb) {
      const parts = vb.split(/\s+/).map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        naturalWidth = parts[2];
        naturalHeight = parts[3];
      }
    }
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      resetView();
      return;
    }
    const availableWidth = viewport.clientWidth - 48;
    const availableHeight = viewport.clientHeight - 48;
    const fitScale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale)));
    setOffset({ x: 0, y: 0 });
  }, [resetView]);

  // 打开时重置视图；关闭后清掉内部状态。
  useEffect(() => {
    if (open) resetView();
  }, [open, resetView, svg]);

  const zoomBy = useCallback((factor: number) => {
    setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor)));
  }, []);

  // Ctrl/Cmd+滚轮缩放。React 的 onWheel 是 passive 监听，preventDefault 无效
  // （浏览器页面缩放拦不住还会刷控制台错误），所以挂原生非 passive listener。
  useEffect(() => {
    const content = contentRef.current;
    if (!open || !content) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setScale((prev) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev * factor)));
    };
    content.addEventListener("wheel", onWheel, { passive: false });
    return () => content.removeEventListener("wheel", onWheel);
  }, [open]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 按钮点击不进入拖拽：pointer capture 会把后续指针事件重定向到 Content，
    // 按钮将收不到 click（这是「预览框按钮全部无效」的原因，勿删此守卫）。
    if ((e.target as HTMLElement).closest("button")) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: offset.x,
      baseY: offset.y,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [offset.x, offset.y]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    setOffset({ x: drag.baseX + (e.clientX - drag.startX), y: drag.baseY + (e.clientY - drag.startY) });
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nezha-mermaid-preview-overlay" />
        <Dialog.Content
          ref={contentRef}
          className="nezha-mermaid-preview-content"
          aria-label={t("mermaid.ariaLabel")}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="nezha-mermaid-preview-titlebar">
            <Dialog.Title className="nezha-mermaid-preview-title">{t("mermaid.previewTitle")}</Dialog.Title>
            <div className="nezha-mermaid-preview-actions">
              <button type="button" className="nezha-mermaid-preview-btn" onClick={() => zoomBy(1 / 1.25)} title={t("mermaid.zoomOut")}>
                <ZoomOut size={14} />
              </button>
              <span className="nezha-mermaid-preview-scale">{Math.round(scale * 100)}%</span>
              <button type="button" className="nezha-mermaid-preview-btn" onClick={() => zoomBy(1.25)} title={t("mermaid.zoomIn")}>
                <ZoomIn size={14} />
              </button>
              <button type="button" className="nezha-mermaid-preview-btn" onClick={fitToWindow} title={t("mermaid.zoomToFit")}>
                <Maximize size={14} />
              </button>
              <Dialog.Close asChild>
                <button type="button" className="nezha-mermaid-preview-btn" title={t("mermaid.close")}>
                  <X size={14} />
                </button>
              </Dialog.Close>
            </div>
          </div>
          <div ref={viewportRef} className="nezha-mermaid-preview-viewport">
            {svg ? (
              <div
                className="nezha-mermaid-preview-canvas"
                style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
