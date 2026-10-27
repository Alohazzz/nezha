/**
 * structured composer 的图片附件纯逻辑（issue #118）。
 * 与 NewTaskView 的粘贴链路同一套 dataUrl 语义；这里抽出可独立测试的
 * 纯函数：clipboard items 过滤、canSend 判定。
 */

/** 与 NewTaskView.PastedImage 同形：本地附件列表条目。 */
export interface ComposerImage {
  id: string;
  dataUrl: string;
}

export function makeImageId(): string {
  return `${Date.now()}-${Math.random()}`;
}

/** clipboardData.items 里 `image/*` 的 File 列表（保序）。 */
export function extractImageFiles(items: ArrayLike<DataTransferItem>): File[] {
  const files: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** File → dataUrl（FileReader 包装为 Promise；读失败 resolve null）。 */
export function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (ev) => resolve((ev.target?.result as string) ?? null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 图片大小上限（dataUrl 字符长度）。超出提示用户、拒收该图。 */
export const MAX_IMAGE_DATA_URL_LENGTH = 20 * 1024 * 1024;

/** 发送门槛（spec：有文字或有图片即可发；disabled/busy 一票否决）。 */
export function composerCanSend(opts: {
  disabled?: boolean;
  busy?: boolean;
  text: string;
  imageCount: number;
}): boolean {
  if (opts.disabled || opts.busy) return false;
  return opts.text.trim().length > 0 || opts.imageCount > 0;
}
