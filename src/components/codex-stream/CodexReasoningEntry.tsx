import { memo } from "react";
import { BrainCircuit } from "lucide-react";
import type { CodexReasoningItem } from "../../types";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";

// 思考卡（issue #117 T3 自 CodexEntryItems 迁出）：骨架管折叠行为。
// 行为矩阵：默认收起，**不参与自动节奏**（autoExpandWhileRunning /
// autoCollapseOnDone 均关）——展开与否完全由用户驱动；展开状态由骨架的模块级
// Map<entryId, boolean> 持久，切任务回来不再丢失（此前 useState 卸载即丢）。

export const CodexReasoningEntry = memo(function CodexReasoningEntry({
  item,
}: {
  item: CodexReasoningItem;
  revision?: number;
}) {
  const text = item.summary.join("\n");
  return (
    <CodexToolCard
      entryId={item.id}
      icon={<BrainCircuit size={11} />}
      category="Thinking"
      text=""
      status="ok"
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
    >
      <div style={s.codexReasoningBlock}>{text}</div>
    </CodexToolCard>
  );
});
