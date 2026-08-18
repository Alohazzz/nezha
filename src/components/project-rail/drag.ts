import { RAIL_ITEM_STRIDE } from "../../styles/rail-drag";

export const RAIL_PADDING_TOP = 10;
// 6px:快速点击时手滑 4px 很常见,阈值太低会把点击武装成拖拽(点击被吞 + 误排序)。
export const RAIL_DRAG_THRESHOLD_PX = 6;
export const RAIL_SUPPRESS_CLICK_MS = 500;
// 指针横向离开 rail 超过该容差即视为逃逸,dropIndex 回落到自身槽位(commit 侧 noop)。
export const RAIL_DRAG_ESCAPE_PX = 60;

export type DragOrigin = {
  draggedId: string;
  offsetX: number;
  offsetY: number;
};

export type DragViz = {
  dropIndex: number;
  previewX: number;
  previewY: number;
};

// 由指针位置计算 dropIndex ∈ [0, visibleLen]。
// 横向逃逸(超出 rail 左右各 RAIL_DRAG_ESCAPE_PX)时回落到 draggedVisibleIndex:
// 点完项目顺势甩向内容区的斜向轨迹,纵向分量会被读成"沿 rail 下拖",若不加横向
// 约束,松手时会把这次误判的微拖拽提交成真实排序(表现为刚点的项目自己跑到下方)。
// 回落到自身槽位既让让位动画复位,又能被 commit 侧的 noop 判定拦下;拖回容差带
// 内则恢复正常落点计算。
export function computeRailDropIndex(
  clientX: number,
  clientY: number,
  railRect: { left: number; right: number; top: number },
  visibleLen: number,
  draggedVisibleIndex: number,
): number {
  const escapedX =
    clientX < railRect.left - RAIL_DRAG_ESCAPE_PX || clientX > railRect.right + RAIL_DRAG_ESCAPE_PX;
  if (escapedX) return Math.max(0, draggedVisibleIndex);
  const relativeY = clientY - railRect.top - RAIL_PADDING_TOP;
  const rawIndex = Math.round(relativeY / RAIL_ITEM_STRIDE);
  return Math.max(0, Math.min(visibleLen, rawIndex));
}

// 让位 transform:dragged 自己不动(用 DragPreview 跟手指),
// 其他项按 dropIndex 与 draggedVisibleIndex 的相对位置平移一个 stride。
// dropIndex ∈ [0, visibleLen],代表"插入到位置 i 之前"。
export function getRailItemTranslateY(
  visibleIndex: number,
  draggedVisibleIndex: number,
  dropIndex: number,
): number {
  if (visibleIndex === draggedVisibleIndex) return 0;
  if (draggedVisibleIndex < dropIndex) {
    if (visibleIndex > draggedVisibleIndex && visibleIndex < dropIndex) return -RAIL_ITEM_STRIDE;
  } else if (draggedVisibleIndex > dropIndex) {
    if (visibleIndex >= dropIndex && visibleIndex < draggedVisibleIndex) return RAIL_ITEM_STRIDE;
  }
  return 0;
}
