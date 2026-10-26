import { memo } from "react";
import { PackageOpen } from "lucide-react";
import type { CodexItemFallback } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { formatJsonText } from "./codexEntryShared";

// 兜底调试卡（issue #117 T3 重做，user story 14）：上游新增的未知条目类型不再
// 是灰色黑盒——type 徽标 + 可展开的原始 JSON（骨架承载折叠行为）。分类 chip
// 即 type 徽标，展开区为整个条目 payload 的 pretty JSON。

export const CodexFallbackEntry = memo(function CodexFallbackEntry({
  item,
}: {
  item: CodexItemFallback;
}) {
  const { t } = useI18n();
  return (
    <CodexToolCard
      entryId={typeof item.id === "string" && item.id ? item.id : `unknown-${item.type}`}
      icon={<PackageOpen size={11} />}
      category={item.type}
      text={t("codex.fallback.hint")}
      status="ok"
      statusLabel="JSON"
    >
      <pre style={s.codexEntryJsonPre}>{formatJsonText(item)}</pre>
    </CodexToolCard>
  );
});
