import type { Terminal } from "@xterm/xterm";

/**
 * 拖选强制本地化——让 Codex 0.16x TUI 运行期间（开启鼠标上报 DECSET
 * ?1002h+?1006h）的文本拖选**不再依赖 Shift**，普通左键拖动即可选中高亮。
 *
 * xterm 6.0.0 bundle 实证：
 * 1. `areMouseEventsActive ? this._selectionService.disable() : ...enable()`——
 *    鼠标上报开启时 xterm 直接**禁用整个选区服务**，普通拖选无高亮；
 * 2. mousedown 分流：`areMouseEventsActive && !shouldForceSelection(e)` →
 *    转发给 PTY；非 Mac 的 `shouldForceSelection` 返回 `e.shiftKey`，所以
 *    Shift+拖选能走本地选区分支（`enable()` 被跳过时该分支自行处理选区）。
 *
 * 因此在 capture 阶段把左键 mousedown/mouseup/mousemove 重派发为
 * `shiftKey: true` 的合成事件：xterm 走本地选区分支，普通拖选即有高亮。
 * 仅拦截左键——右键/中键继续走 xterm 原生路径（转发或本地菜单），Codex
 * 的点击交互不受影响。滚轮不在本模块处理（见 terminalWheel.ts）。
 */

/** 合成事件标记：重派发的事件会被本模块的 capture listener 再次看到，必须
 *  放行否则无限循环（合成 → 捕获 → 再合成 …）。 */
const FORCED_FLAG = "__nezhaSelectionForce";

function isLeftButton(e: MouseEvent): boolean {
  return e.button === 0 && !(e as MouseEvent & { [FORCED_FLAG]?: boolean })[FORCED_FLAG];
}

function redispatchWithShift(e: MouseEvent): void {
  // capture 阶段先压掉 xterm 对原始事件的转发分支，再把带 shiftKey 的合成
  // 事件派发回同一元素——xterm selection 的 handleMouseDown 在 _enabled=false
  // 时对 Shift 事件 stopPropagation 并直接启动本地拖选（bundle 实证），
  // 无需选区服务处于 enable 态。
  e.preventDefault();
  e.stopPropagation();
  const clone = new MouseEvent(e.type, {
    bubbles: true,
    cancelable: true,
    // 不传 view：xterm 不读 event.view，而 jsdom 环境下跨 realm 传 window
    // 实例会抛 TypeError（真机浏览器无此问题，省略即两端兼容）。
    detail: e.detail,
    screenX: e.screenX,
    screenY: e.screenY,
    clientX: e.clientX,
    clientY: e.clientY,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    // 关键：xterm shouldForceSelection 非 Mac 分支只看 shiftKey
    shiftKey: true,
    button: e.button,
    buttons: e.buttons,
    relatedTarget: e.relatedTarget,
  });
  (clone as MouseEvent & { [FORCED_FLAG]?: boolean })[FORCED_FLAG] = true;
  (e.target as EventTarget).dispatchEvent(clone);
}

/**
 * 需要重派发的条件：当前终端鼠标上报开启且在 alt buffer（全屏 TUI 场景）。
 * normal buffer 的拖选与鼠标上报无关（xterm 本地处理），不拦截。
 */
function shouldForceLocal(term: Terminal | null): boolean {
  return !!term && term.modes.mouseTrackingMode !== "none";
}

/**
 * 在容器上挂 capture 阶段鼠标监听。返回 dispose 函数。
 * `getTerminal` 与 terminalWheel 同款懒取（终端实例晚于容器挂载）。
 */
export function attachSelectionForce(
  container: HTMLElement,
  getTerminal: () => Terminal | null,
): () => void {
  const handle = (e: MouseEvent) => {
    if (!isLeftButton(e)) return;
    // mousemove 只在拖选进行中（按住左键）才有意义，避免高频路径空转
    if (e.type === "mousemove" && !(e.buttons & 1)) return;
    if (!shouldForceLocal(getTerminal())) return;
    redispatchWithShift(e);
  };

  container.addEventListener("mousedown", handle, { capture: true });
  container.addEventListener("mouseup", handle, { capture: true });
  container.addEventListener("mousemove", handle, { capture: true });
  return () => {
    container.removeEventListener("mousedown", handle, { capture: true });
    container.removeEventListener("mouseup", handle, { capture: true });
    container.removeEventListener("mousemove", handle, { capture: true });
  };
}
