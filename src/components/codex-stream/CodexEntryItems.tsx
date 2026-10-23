import { memo, useState } from "react";
import {
  BrainCircuit,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Copy,
  FileEdit,
  ListTodo,
  Plug,
  TerminalSquare,
  X,
} from "lucide-react";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexMcpToolCallItem,
  CodexPlanItem,
  CodexReasoningItem,
  CodexUserMessageItem,
} from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexMarkdown } from "./CodexMarkdown";

// 条目状态点的颜色语义：running=提示色 / completed=成功 / failed|declined=错误
function statusDotColor(status: string): string {
  if (status === "completed") return "var(--color-success)";
  if (status === "failed" || status === "declined") return "var(--color-error)";
  return "var(--text-hint)";
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 助手消息（Markdown 渲染，流式期间随 delta 增长）。 */
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

/** 用户消息气泡（右对齐，纯文本）。 */
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

/** 思考摘要：可折叠，斜体弱化（SessionView ThinkingBlock 同款交互）。 */
export const CodexReasoningEntry = memo(function CodexReasoningEntry({
  item,
}: {
  item: CodexReasoningItem;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const text = item.summary.join("\n");
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        style={s.codexReasoningToggle}
      >
        {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <BrainCircuit size={11} />
        <span>{t("session.thinking")}</span>
      </button>
      {expanded && text && <div style={s.codexReasoningBlock}>{text}</div>}
    </div>
  );
});

/** 计划条目（Markdown，弱边框卡片）。 */
export const CodexPlanEntry = memo(function CodexPlanEntry({ item }: { item: CodexPlanItem }) {
  return (
    <div style={{ ...s.codexEntryCard, borderStyle: "dashed" }}>
      <div style={{ ...s.codexEntryHeader, cursor: "default" }}>
        <ListTodo size={12} style={{ flexShrink: 0 }} />
        <span style={s.codexEntryHeaderLabel}>Plan</span>
      </div>
      <div style={{ padding: "8px 12px" }} className="session-prose">
        <CodexMarkdown text={item.text} />
      </div>
    </div>
  );
});

/** 命令执行：头部（命令 + 状态）+ 可折叠输出。流式期间输出自动展开。 */
export const CodexCommandEntry = memo(function CodexCommandEntry({
  item,
  streaming,
}: {
  item: CodexCommandExecutionItem;
  streaming?: boolean;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const [expanded, setExpanded] = useState(running || streaming === true);
  const [copied, setCopied] = useState(false);
  const hasOutput = Boolean(item.aggregatedOutput);

  const handleCopy = () => {
    if (!item.aggregatedOutput) return;
    navigator.clipboard.writeText(item.aggregatedOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const duration = formatDuration(item.durationMs);
  return (
    <div style={s.codexEntryCard}>
      <button
        type="button"
        style={s.codexEntryHeader}
        onClick={() => hasOutput && setExpanded((e) => !e)}
        disabled={!hasOutput}
      >
        {running ? (
          <CircleDashed size={12} className="spin" style={{ flexShrink: 0 }} />
        ) : (
          <span style={{ ...s.codexStatusDot, background: statusDotColor(item.status) }} />
        )}
        <TerminalSquare size={11} style={{ color: "var(--text-hint)", flexShrink: 0 }} />
        <span style={s.codexEntryHeaderLabel}>{item.command}</span>
        {item.exitCode !== null && item.exitCode !== 0 && (
          <span style={{ ...s.codexEntryHeaderMeta, color: "var(--color-error)" }}>
            exit {item.exitCode}
          </span>
        )}
        {duration && <span style={s.codexEntryHeaderMeta}>{duration}</span>}
      </button>
      {expanded && hasOutput && (
        <div style={{ position: "relative" }}>
          <pre style={s.codexEntryBody}>{item.aggregatedOutput}</pre>
          <button
            type="button"
            title={copied ? undefined : t("common.copy")}
            onClick={handleCopy}
            style={{
              position: "absolute",
              top: 4,
              right: 6,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 2,
              color: "var(--text-muted)",
              display: "flex",
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}
    </div>
  );
});

/** 文件变更：逐文件渲染 diff（unified diff 文本，行级着色）。 */
export const CodexFileChangeEntry = memo(function CodexFileChangeEntry({
  item,
}: {
  item: CodexFileChangeItem;
}) {
  const failed = item.status === "failed" || item.status === "declined";
  return (
    <div style={s.codexEntryCard}>
      <div style={{ ...s.codexEntryHeader, cursor: "default" }}>
        <span style={{ ...s.codexStatusDot, background: statusDotColor(item.status) }} />
        <FileEdit size={11} style={{ color: "var(--text-hint)", flexShrink: 0 }} />
        <span style={s.codexEntryHeaderLabel}>
          {item.changes.length > 0
            ? item.changes.map((c) => c.path).join(", ")
            : "file change"}
        </span>
        <span style={s.codexEntryHeaderMeta}>{item.status}</span>
      </div>
      {item.changes.map((change) => (
        <div key={change.path}>
          <div style={s.codexDiffFileHeader}>
            <span>{change.path}</span>
            {change.kind.type === "update" && change.kind.movePath && (
              <span style={s.codexEntryHeaderMeta}>→ {change.kind.movePath}</span>
            )}
          </div>
          <pre style={s.codexDiffPre}>
            {change.diff.split("\n").map((line, i) => (
              <span
                key={i}
                style={{
                  display: "block",
                  color:
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "var(--color-success)"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "var(--color-error)"
                        : "var(--text-secondary)",
                  background:
                    line.startsWith("+") && !line.startsWith("+++")
                      ? "rgba(80, 200, 120, 0.08)"
                      : line.startsWith("-") && !line.startsWith("---")
                        ? "rgba(220, 80, 80, 0.08)"
                        : undefined,
                }}
              >
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      ))}
      {failed && (
        <div style={{ ...s.codexEntryBody, ...s.codexEntryBodyRunning }}>{item.status}</div>
      )}
    </div>
  );
});

/** MCP 工具调用：服务器/工具名 + 状态，参数与输出折叠。 */
export const CodexMcpToolCallEntry = memo(function CodexMcpToolCallEntry({
  item,
}: {
  item: CodexMcpToolCallItem;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const running = item.status === "inProgress";
  return (
    <div style={s.codexEntryCard}>
      <button
        type="button"
        style={s.codexEntryHeader}
        onClick={() => setExpanded((e) => !e)}
      >
        {running ? (
          <CircleDashed size={12} className="spin" style={{ flexShrink: 0 }} />
        ) : (
          <span style={{ ...s.codexStatusDot, background: statusDotColor(item.status) }} />
        )}
        <Plug size={11} style={{ color: "var(--text-hint)", flexShrink: 0 }} />
        <span style={s.codexEntryHeaderLabel}>
          {item.server}: {item.tool}
        </span>
        {typeof item.durationMs === "number" && (
          <span style={s.codexEntryHeaderMeta}>{formatDuration(item.durationMs)}</span>
        )}
        {expanded ? (
          <ChevronDown size={11} style={{ flexShrink: 0 }} />
        ) : (
          <ChevronRight size={11} style={{ flexShrink: 0 }} />
        )}
      </button>
      {expanded && (
        <pre style={s.codexEntryBody}>{JSON.stringify(item, null, 2)}</pre>
      )}
      {!expanded && item.status === "failed" && (
        <div style={{ ...s.codexEntryBody, ...s.codexEntryBodyRunning, color: "var(--color-error)" }}>
          {t("task.failed")}
        </div>
      )}
    </div>
  );
});

/** 兜底：上游新增条目类型，显示 type 占位不渲染内容。 */
export const CodexFallbackEntry = memo(function CodexFallbackEntry({
  itemType,
}: {
  itemType: string;
}) {
  return (
    <div style={{ ...s.codexEntryCard, opacity: 0.55 }}>
      <div style={{ ...s.codexEntryHeader, cursor: "default" }}>
        <X size={11} style={{ flexShrink: 0 }} />
        <span style={s.codexEntryHeaderLabel}>{itemType}</span>
      </div>
    </div>
  );
});
