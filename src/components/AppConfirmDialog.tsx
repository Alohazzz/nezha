import { useCallback, useRef, useSyncExternalStore } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { useI18n } from "../i18n";

/**
 * 应用内确认框——替代 `plugin-dialog` 原生 `confirm()` 的统一入口。
 *
 * 原生框无法跟随 Nezha 主题（暗色界面里弹出系统白框），长消息也会被压折得读不出
 * 边界；先例见 `PruneRemoteConfirmDialog` / `StaleBranchCleanup` 的注释。本模块把
 * 这套「遮罩 + 居中卡片」收敛成 promise API，调用形态与原生 `confirm()` 对齐：
 *
 *   const ok = await appConfirm("确认删除 X？", { title: "删除", kind: "warning" });
 *
 * 样式复用 `build-dialog-*` 骨架（与分支批处理 bbDialog 同规格），host 组件挂在
 * `main.tsx`（I18nProvider 内，默认按钮文案走词典）。
 */
export interface AppConfirmOptions {
  /** 标题栏文案；缺省回落到「确定」。 */
  title?: string;
  /** `warning` / `error` 显示红色确认按钮（当前全部调用都是告警确认），`info` 走主色。 */
  kind?: "info" | "warning" | "error";
  /** 确认按钮文案；缺省 `common.confirm`（确定 / OK）。 */
  okLabel?: string;
  /** 取消按钮文案；缺省 `common.cancel`（取消 / Cancel）。 */
  cancelLabel?: string;
}

interface ConfirmRequest {
  message: string;
  options: AppConfirmOptions;
  resolve: (ok: boolean) => void;
}

let pendingConfirm: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();

function notifyConfirmListeners() {
  confirmListeners.forEach((listener) => listener());
}

function subscribeConfirm(listener: () => void) {
  confirmListeners.add(listener);
  return () => {
    confirmListeners.delete(listener);
  };
}

function getConfirmSnapshot() {
  return pendingConfirm;
}

/**
 * 打开应用内确认框，用户点确认/取消（或 Esc、点遮罩）后 resolve。
 *
 * 与原生阻塞式 `confirm()` 不同，两次调用可能交叠：后到的确认会把未决的旧确认按
 * 「取消」结算并顶掉，否则旧 promise 永远不 resolve。
 */
export function appConfirm(message: string, options: AppConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    pendingConfirm?.resolve(false);
    pendingConfirm = { message, options, resolve };
    notifyConfirmListeners();
  });
}

function settleConfirm(ok: boolean) {
  const request = pendingConfirm;
  pendingConfirm = null;
  notifyConfirmListeners();
  request?.resolve(ok);
}

/**
 * 确认框宿主：订阅 `appConfirm` 请求并渲染 Radix 弹层。全应用仅在 `main.tsx` 挂载一次，
 * 不要在业务组件里重复渲染。
 */
export function AppConfirmHost() {
  const { t } = useI18n();
  const request = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot, getConfirmSnapshot);
  const contentRef = useRef<HTMLDivElement>(null);

  // Esc / 点遮罩 / 关闭按钮统一走「取消」，与原生 confirm 的 Esc 行为一致。
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) settleConfirm(false);
  }, []);

  const kind = request?.options.kind ?? "warning";
  const okVariant = kind === "info" ? "primary" : "danger";

  return (
    <Dialog.Root open={request !== null} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="build-dialog-overlay" />
        <Dialog.Content
          ref={contentRef}
          className="build-dialog"
          aria-describedby="app-confirm-lead"
          // 焦点落在弹层容器本身：避免打开瞬间把焦点交给红色确认键，回车误触告警确认
          // （先例同 PruneRemoteConfirmDialog）；Tab 照常进入按钮序列。
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <div className="build-dialog-head">
            <span className="build-dialog-icon">
              <AlertTriangle size={15} />
            </span>
            <Dialog.Title className="build-dialog-title">
              {request?.options.title ?? t("common.confirm")}
            </Dialog.Title>
            <Dialog.Close className="build-dialog-close" aria-label={t("common.close")}>
              <X size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Description
            className="build-dialog-lead"
            id="app-confirm-lead"
            data-pre={request?.message.includes("\n") ? "true" : undefined}
          >
            {request?.message ?? ""}
          </Dialog.Description>
          <div className="build-dialog-actions">
            <button className="rp-btn" onClick={() => settleConfirm(false)}>
              {request?.options.cancelLabel ?? t("common.cancel")}
            </button>
            <button className="rp-btn" data-variant={okVariant} onClick={() => settleConfirm(true)}>
              {request?.options.okLabel ?? t("common.confirm")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
