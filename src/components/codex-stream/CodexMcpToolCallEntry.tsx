import { memo, type ReactNode } from "react";
import { Plug } from "lucide-react";
import type { CodexMcpToolCallItem, CodexMcpToolCallResult } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { formatDuration, formatJsonText } from "./codexEntryShared";

// MCP 工具调用卡（issue #117 T3 自 CodexEntryItems 迁出 + 重做展开区）。
// 行为矩阵：默认收起、运行中自动展开、完成自动收起。展开后**参数与结果分两块
// 结构化区域展示**（user story 11），不再整包 JSON 倾倒：
// - Arguments：arguments 的 pretty JSON；
// - Result：content 文本块优先（`{type:"text"}` 直接给文本），其余块与
//   structuredContent 以 pretty JSON 兜底；无 result 时显示空态文案。
// 失败态：error.message 进骨架失败 tooltip。

export const CodexMcpToolCallEntry = memo(function CodexMcpToolCallEntry({
  item,
}: {
  item: CodexMcpToolCallItem;
  revision?: number;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const failed = item.status === "failed";
  const status: "running" | "ok" | "failed" = running ? "running" : failed ? "failed" : "ok";
  const hasBody = Boolean(item.arguments !== undefined) || Boolean(item.result) || Boolean(item.error);
  const duration = formatDuration(item.durationMs);

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<Plug size={11} />}
      category="MCP"
      text={`${item.server}: ${item.tool}`}
      status={status}
      failureDetail={item.error?.message ?? null}
      collapsible={hasBody}
      autoExpandWhileRunning
      autoCollapseOnDone
      meta={duration ? <span style={s.codexToolMeta}>{duration}</span> : null}
    >
      {item.arguments !== undefined && (
        <McpSection label={t("codex.mcp.arguments")}>
          <pre style={s.codexEntryJsonPre}>{formatJsonText(item.arguments)}</pre>
        </McpSection>
      )}
      {item.result ? (
        <McpSection label={t("codex.mcp.result")}>
          <McpResultBody result={item.result} />
        </McpSection>
      ) : (
        !running && (
          <McpSection label={t("codex.mcp.result")}>
            <div style={s.codexEntrySectionEmpty}>{t("codex.mcp.noResult")}</div>
          </McpSection>
        )
      )}
    </CodexToolCard>
  );
});

/** 展开区的结构化小节：小节标签 + 内容。 */
function McpSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={s.codexEntrySection}>
      <div style={s.codexEntrySectionLabel}>{label}</div>
      {children}
    </div>
  );
}

/** 结果体：文本 content 块直出文本，其余块 / structuredContent 走 JSON 兜底。 */
function McpResultBody({ result }: { result: CodexMcpToolCallResult }) {
  const isTextBlock = (block: unknown): block is { type: "text"; text: string } =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string";
  const textBlocks = (Array.isArray(result.content) ? result.content : []).filter(isTextBlock);
  const otherBlocks = (Array.isArray(result.content) ? result.content : []).filter(
    (block) => !isTextBlock(block),
  );

  return (
    <>
      {textBlocks.map((block, i) => (
        <pre key={`text-${i}`} style={s.codexEntryJsonPre}>
          {block.text}
        </pre>
      ))}
      {otherBlocks.length > 0 && <pre style={s.codexEntryJsonPre}>{formatJsonText(otherBlocks)}</pre>}
      {result.structuredContent !== undefined && result.structuredContent !== null && (
        <pre style={s.codexEntryJsonPre}>{formatJsonText(result.structuredContent)}</pre>
      )}
    </>
  );
}
