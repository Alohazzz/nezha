import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Image as ImageIcon } from "lucide-react";
import type { CodexImageViewItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { ImageLightbox } from "../common/ImageLightbox";
import { CodexToolCard } from "./CodexToolCard";
import { useCodexStreamProjectPath } from "./codexStreamContext";

// 图片查看卡（上游 `ThreadItem::ImageView` —— `view_image` 工具的产物）。
//
// 这条目只有一个 id 和一个本机绝对路径，此前没有渲染器，于是整条落进兜底
// 「上游未知条目类型」卡：用户看到的是 `{id, path, type}` 三个字段，模型真正
// 看了哪张图完全不可知。这里把路径解析成 dataUrl 直接出缩略图。
//
// 解析走 `read_image_preview`（与 FileViewer / 用户消息气泡同一条通路）：
// CSP 只放行 self/data:/blob:，`file://` 路径不能直接当 src；该命令同时完成
// 路径根校验与 10MB 上限拦截。
//
// 失败态不吞掉：路径缺失、项目路径未知、文件被清理、格式不支持、超限都要在
// 卡片里明说，否则「图片没出来」又是一次黑盒。摘要行因此不用不折叠形态，
// 展开区始终承载失败原因与原始路径。

/** 提取文件名做摘要行文本（路径本身太长，塞满整行没有信息量）。 */
function fileNameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || path;
}

export const CodexImageViewEntry = memo(function CodexImageViewEntry({
  item,
}: {
  item: CodexImageViewItem;
}) {
  const { t } = useI18n();
  const projectPath = useCodexStreamProjectPath();
  const path = typeof item.path === "string" ? item.path.trim() : "";
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    setDataUrl(null);
    setFailure(null);
    setDimensions(null);
    if (!path) {
      setFailure(t("codex.image.unavailable"));
      return;
    }
    if (!projectPath) {
      // 没有项目根就无从做路径校验——明说原因，不要静默留白。
      setFailure(t("codex.image.unavailable"));
      return;
    }
    let cancelled = false;
    invoke<{ dataUrl: string }>("read_image_preview", { path, projectPath })
      .then((res) => {
        if (!cancelled) setDataUrl(res.dataUrl);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = typeof e === "string" ? e : e instanceof Error ? e.message : "";
        setFailure(message || t("codex.image.unavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [path, projectPath, t]);

  const failed = failure !== null;
  const running = !failed && dataUrl === null;
  const status = failed ? "failed" : running ? "running" : "ok";

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<ImageIcon size={11} />}
      category={t("codex.tool.category.image")}
      text={path ? fileNameOf(path) : t("codex.image.unavailable")}
      status={status}
      failureDetail={failure}
      // 成功 / 加载中不占状态词（类别词的高亮已经表达进行中），失败必须显式标出。
      showStatus={failed}
      // 图片本身就是内容：加载完默认展开，别让用户多点一次才看到图。
      defaultExpanded
      autoExpandWhileRunning
      autoCollapseOnDone={false}
      collapsible
      meta={
        dimensions ? (
          <span style={s.codexToolMeta}>
            {t("codex.image.dimensions", {
              width: dimensions.width,
              height: dimensions.height,
            })}
          </span>
        ) : null
      }
    >
      <div style={s.codexEntrySection}>
        {dataUrl ? (
          <div style={s.codexImagePreviewWrap}>
            <img
              src={dataUrl}
              alt=""
              className="codex-image-preview"
              style={s.codexImagePreview}
              onClick={() => setPreviewing(true)}
              onLoad={(e) =>
                setDimensions({
                  width: e.currentTarget.naturalWidth,
                  height: e.currentTarget.naturalHeight,
                })
              }
            />
          </div>
        ) : (
          <div style={failed ? s.codexImageError : s.codexEntrySectionEmpty}>
            {failure ?? t("codex.image.loading")}
          </div>
        )}
        {path && (
          <div className="codex-stream-image-path">
            <span className="codex-stream-image-path-label">{t("codex.image.path")}</span>
            <span className="codex-stream-image-path-value">{path}</span>
          </div>
        )}
      </div>
      {previewing && dataUrl && (
        <ImageLightbox src={dataUrl} onClose={() => setPreviewing(false)} />
      )}
    </CodexToolCard>
  );
});
