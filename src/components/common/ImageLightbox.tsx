import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import s from "../../styles";

/**
 * 全局图片灯箱（点击缩略图放大预览）：portal 到 body 的全屏遮罩，
 * 点击遮罩 / 关闭按钮 / Esc 关闭。图片可能来自 dataUrl（composer 附件、
 * 乐观气泡回显）或经 read_image_preview 转出的 dataUrl，src 一律由调用方
 * 解析好再传入，本组件不做路径转换。
 */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  return createPortal(
    <div
      style={s.imageLightboxOverlay}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt ?? "image preview"}
    >
      <img
        src={src}
        alt={alt ?? ""}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        style={s.imageLightboxImg}
      />
      <button
        type="button"
        style={s.imageLightboxClose}
        onClick={onClose}
        aria-label="close preview"
      >
        <X size={16} strokeWidth={2.2} />
      </button>
    </div>,
    document.body,
  );
}
