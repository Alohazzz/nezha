import { memo } from "react";
import type { CodexAgentMessageItem } from "../../types";
import s from "../../styles";
import { CodexMarkdown } from "./CodexMarkdown";

// 助手消息（issue #117 T3 自 CodexEntryItems 迁出）：Markdown 渲染，流式期间随
// delta 增长（T1 不可变归并让 memo 真正生效）。不折叠、不包骨架。

export const CodexAgentMessageEntry = memo(function CodexAgentMessageEntry({
  item,
}: {
  item: CodexAgentMessageItem;
}) {
  return (
    <div style={s.codexAgentMessage} className="session-prose">
      <CodexMarkdown text={item.text} />
    </div>
  );
});
