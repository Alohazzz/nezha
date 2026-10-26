import { memo } from "react";
import type { CodexUserMessageItem } from "../../types";
import s from "../../styles";

// 用户消息气泡（issue #117 T3 自 CodexEntryItems 迁出）：右对齐纯文本。
// 不折叠、不包骨架。

export const CodexUserMessageEntry = memo(function CodexUserMessageEntry({
  item,
}: {
  item: CodexUserMessageItem;
}) {
  const text = item.content
    .map((c) => (typeof c?.text === "string" ? c.text : ""))
    .filter(Boolean)
    .join("\n");
  if (!text.trim()) return null;
  return (
    <div style={s.codexUserBubbleWrap}>
      <div style={s.codexUserBubble}>{text}</div>
    </div>
  );
});
