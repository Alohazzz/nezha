import { memo } from "react";
import { ListTodo } from "lucide-react";
import type { CodexPlanItem } from "../../types";
import s from "../../styles";
import { CodexMarkdown } from "./CodexMarkdown";

// 计划条目（issue #117 T3 自 CodexEntryItems 迁出）：Markdown 弱边框卡片。
// 不折叠、不包骨架（行为矩阵：消息与计划不折叠）。

export const CodexPlanEntry = memo(function CodexPlanEntry({ item }: { item: CodexPlanItem }) {
  return (
    <div style={s.codexPlanCard}>
      <div style={s.codexPlanHeader}>
        <ListTodo size={12} style={s.codexPlanIcon} />
        <span style={s.codexEntryHeaderLabel}>Plan</span>
      </div>
      <div style={s.codexPlanBody} className="session-prose">
        <CodexMarkdown text={item.text} />
      </div>
    </div>
  );
});
