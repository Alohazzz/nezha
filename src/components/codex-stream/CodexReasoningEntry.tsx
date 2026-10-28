import { memo } from "react";
import { BrainCircuit } from "lucide-react";
import type { CodexReasoningItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { CodexThoughtLine, resolveLatestThoughtLine } from "./CodexThoughtLine";

// 思考卡（issue #117 T3 自 CodexEntryItems 迁出；#119 纳入自动节奏 + 动态计时）：
// 骨架管折叠行为。reasoning item 无 status 字段，完成态以「endedAtMs 已写入」
// 判定（#119 Implementation Decisions），否则视为 running。
//
// 结构化改版（对标 ZCode ReasoningTrigger）：思考正文**不再自动展开**——流式中
// 自动展开会把工具与正文持续往下挤。改为在摘要行内滚动展示最新一段思考
// （CodexThoughtLine：取最后一行非空内容、超宽跟随尾部并双侧渐隐），
// 完整正文保留在手动展开区。展开状态仍由骨架的模块级 Map 持久。

/** 完成态摘要行主文本截断长度（流式中改为尾部跟播，不再需要截断）。 */
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
  const running = endedAtMs == null;
  const status = running ? "running" : "ok";
  const fullText = item.summary.join("\n");
  // 流式中：尾部最新一行（跟播）；完成后：摘要首行截断（静态）
  const lineText = running
    ? resolveLatestThoughtLine(fullText)
    : (item.summary[0] ?? "").slice(0, SUMMARY_LINE_MAX_CHARS);
  return (
    <CodexToolCard
      entryId={item.id}
      icon={<BrainCircuit size={11} />}
      category={t("codex.tool.category.thinking")}
      textSlot={<CodexThoughtLine text={lineText} live={running} />}
      status={status}
      // 不渲染状态词：类别词「思考」+ 右侧耗时已经表达完整，再叠「已思考 /
      // 思考中」是同一行内的重复信息（密集度改版）
      showStatus={false}
      // 不自动展开：摘要行本身就是思考内容的实况展示
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
      // 展开后正文已完整呈现，摘要行不再重复跟播（ZCode：展开态只留标签）
      hideTextWhenExpanded
      streamingRevision={revision}
      meta={
        startedAtMs != null ? (
          <span style={s.codexToolMeta}>
            <CodexLiveDuration startedAtMs={startedAtMs} endedAtMs={endedAtMs} />
          </span>
        ) : undefined
      }
    >
      <div style={s.codexReasoningBlock} data-testid="codex-reasoning-body">{fullText}</div>
    </CodexToolCard>
  );
});
