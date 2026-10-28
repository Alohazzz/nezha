import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sparkles } from "lucide-react";
import type { CodexUserMessageItem } from "../../types";
import { splitSkillMentions } from "../../skillMention";
import { useCodexStreamProjectPath } from "./codexStreamContext";
import { ImageLightbox } from "../common/ImageLightbox";
import s from "../../styles";

// 用户消息气泡（issue #117 T3 自 CodexEntryItems 迁出）：右对齐，文本 + 可选
// 图片缩略图（issue #118）。图片项两种来源：
// - 乐观气泡（steer/resume 提交的本地回显）：dataUrl，<img> 直渲；
// - 上游回放帧（resume 重放的权威条目）：附件本地路径，CSP 只放行 self/data:
//   blob:，不能直接当 src，经 read_image_preview 转 dataUrl（FileViewer 预览
//   同一命令）。加载失败不渲染该图（文本仍在，图片缺失不阻塞消息流）。
// 技能提及在正文里是 canonical 长句（带 SKILL.md 路径），渲染时折回紧凑 chip，
// 气泡不至于被路径撑满（对齐 ZCode 的 mention chip）。
// 不折叠、不包骨架。

export const CodexUserMessageEntry = memo(function CodexUserMessageEntry({
  item,
}: {
  item: CodexUserMessageItem;
}) {
  const projectPath = useCodexStreamProjectPath();
  const text = item.content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  const images = item.content
    .map((c) => (c?.type === "localImage" ? (c.url ?? c.path ?? "") : ""))
    .filter(Boolean);
  if (!text.trim() && images.length === 0) return null;
  return (
    <div style={s.codexUserBubbleWrap}>
      <div style={s.codexUserBubble}>
        {splitSkillMentions(text).map((part, i) =>
          part.type === "skill" ? (
            <span key={i} style={s.codexUserSkillChip} title={part.path}>
              <Sparkles size={11} strokeWidth={2.2} />
              {part.label}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          ),
        )}
        {images.length > 0 && (
          <div style={s.codexUserBubbleImages}>
            {images.map((src, i) => (
              <BubbleImage key={i} src={src} projectPath={projectPath} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

/** dataUrl 直接渲染；本地绝对路径懒加载转 dataUrl（无 projectPath 时放弃）。 */
function BubbleImage({ src, projectPath }: { src: string; projectPath: string | null }) {
  const isDataUrl = src.startsWith("data:");
  const [loaded, setLoaded] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (isDataUrl || !projectPath) return;
    let cancelled = false;
    invoke<{ dataUrl: string }>("read_image_preview", { path: src, projectPath })
      .then((res) => {
        if (!cancelled) setLoaded(res.dataUrl);
      })
      .catch(() => {
        /* 附件已被清理 / 格式不支持：缺图不阻塞消息流 */
      });
    return () => {
      cancelled = true;
    };
  }, [isDataUrl, projectPath, src]);

  const resolved = isDataUrl ? src : loaded;
  if (!resolved) return null;
  return (
    <>
      <img
        src={resolved}
        style={s.codexUserBubbleImage}
        className="codex-bubble-image"
        alt=""
        onClick={() => setPreviewing(true)}
      />
      {previewing && (
        <ImageLightbox src={resolved} onClose={() => setPreviewing(false)} />
      )}
    </>
  );
}
