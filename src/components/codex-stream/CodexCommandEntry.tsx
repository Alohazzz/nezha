import { memo, useState } from "react";
import { Check, Copy, SquareTerminal } from "lucide-react";
import type { CodexCommandExecutionItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { formatDuration } from "./codexEntryShared";

// 命令执行卡（issue #117 T3 自 CodexEntryItems 迁出）：骨架管行为（折叠持久 /
// 自动边沿 / 失败 tooltip），本卡只管内容渲染。行为矩阵：默认收起、流式中自动
// 展开、完成自动收起。展开区保持全量输出渲染——尾部截断是 T5 的事。

export const CodexCommandEntry = memo(function CodexCommandEntry({
  item,
  revision,
}: {
  item: CodexCommandExecutionItem;
  /** T1 归并层的条目修订号（输出 delta 递增），驱动骨架自动展开边沿。 */
  revision?: number;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || item.status === "declined";
  const status: "running" | "ok" | "failed" = running ? "running" : failed ? "failed" : "ok";
  const hasOutput = Boolean(item.aggregatedOutput);
  const duration = formatDuration(item.durationMs);

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<SquareTerminal size={11} />}
      category="Command"
      text={item.command}
      status={status}
      statusLabel={item.exitCode !== null && item.exitCode !== 0 ? `exit ${item.exitCode}` : undefined}
      failureDetail={failed ? (item.aggregatedOutput ?? item.status) : null}
      collapsible={hasOutput}
      autoExpandWhileRunning
      autoCollapseOnDone
      streamingRevision={revision}
      meta={
        <>
          {item.exitCode !== null && item.exitCode !== 0 && (
            <span style={s.codexToolMetaError}>exit {item.exitCode}</span>
          )}
          {duration && <span style={s.codexToolMeta}>{duration}</span>}
        </>
      }
    >
      <CommandOutputBody output={item.aggregatedOutput} copyLabel={t("common.copy")} />
    </CodexToolCard>
  );
});

/** 命令输出体：pre + 复制全文按钮（内容渲染保持原样）。 */
function CommandOutputBody({ output, copyLabel }: { output: string | null; copyLabel: string }) {
  const [copied, setCopied] = useState(false);
  if (!output) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={s.codexCommandOutputWrap}>
      <pre style={s.codexEntryBody}>{output}</pre>
      <button
        type="button"
        className="codex-stream-copy-btn"
        title={copied ? undefined : copyLabel}
        onClick={handleCopy}
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}
