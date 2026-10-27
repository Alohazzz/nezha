import { memo } from "react";
import { BrainCircuit } from "lucide-react";
import type { CodexReasoningItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";

// 思考卡（issue #117 T3 自 CodexEntryItems 迁出；#119 纳入自动节奏 + 动态计时）：
// 骨架管折叠行为。reasoning item 无 status 字段，完成态以「endedAtMs 已写入」
// 判定（#119 Implementation Decisions），否则视为 running。
// 行为矩阵与命令卡一致：默认收起、流式中自动展开、完成自动收起、手动 toggle
// 永久优先——全部复用 CodexToolCard 既有边沿机制，展开状态由骨架的模块级
// Map<entryId, boolean> 持久，切任务回来不再丢失。

/** 摘要行主文本截断长度（spec：首行截断 ~80 字符）。 */
const SUMMARY_LINE_MAX_CHARS = 80;

export const CodexReasoningEntry = memo(function CodexReasoningEntry({
  item,
  revision,
  startedAtMs,
  endedAtMs,
}: {
  item: CodexReasoningItem;
  revision?: number;
  /** 归并层条目时间戳（#119）：起点/终点毫秒；完成定格、运行中跳动。 */
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}) {
  const { t } = useI18n();
  const done = endedAtMs != null;
  const status = done ? "ok" : "running";
  const summaryLine = (item.summary[0] ?? "").slice(0, SUMMARY_LINE_MAX_CHARS);
  const text = item.summary.join("\n");
  return (
    <CodexToolCard
      entryId={item.id}
      icon={<BrainCircuit size={11} />}
      category={t("codex.tool.category.thinking")}
      text={summaryLine}
      status={status}
      statusLabel={done ? t("codex.tool.thought") : t("codex.tool.thinking")}
      autoExpandWhileRunning
      autoCollapseOnDone
      streamingRevision={revision}
      meta={
        startedAtMs != null ? (
          <span style={s.codexToolMeta}>
            <CodexLiveDuration startedAtMs={startedAtMs} endedAtMs={endedAtMs} />
          </span>
        ) : undefined
      }
    >
      <div style={s.codexReasoningBlock} data-testid="codex-reasoning-body">{text}</div>
    </CodexToolCard>
  );
});
