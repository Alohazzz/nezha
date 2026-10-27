import { memo, useState } from "react";
import { Check, Copy, SquareTerminal } from "lucide-react";
import type { CodexCommandExecutionItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { formatDuration, truncateOutputTail } from "./codexEntryShared";

// 命令执行卡（issue #117 T3 自 CodexEntryItems 迁出；T5 接尾部截断；#119 补
// 运行中动态秒数）：骨架管行为（折叠持久 / 自动边沿 / 失败 tooltip），本卡只管
// 内容渲染。行为矩阵：默认收起、流式中自动展开、完成自动收起。展开区只渲染
// 输出尾部（~64KB、按整行取尾，spec user story 15）；全量输出保留在内存条目上，
// 复制全文按钮复制完整文本。
// 运行中 meta 由 CodexLiveDuration 以条目 startedAtMs 起跳；完成后以权威
// durationMs 替换（spec user story 8/9）。

export const CodexCommandEntry = memo(function CodexCommandEntry({
  item,
  revision,
  startedAtMs,
  endedAtMs,
}: {
  item: CodexCommandExecutionItem;
  /** T1 归并层的条目修订号（输出 delta 递增），驱动骨架自动展开边沿。 */
  revision?: number;
  /** 归并层条目时间戳（#119）：running 时动态计时起点。 */
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || item.status === "declined";
  const status: "running" | "ok" | "failed" = running ? "running" : failed ? "failed" : "ok";
  const hasOutput = Boolean(item.aggregatedOutput);
  const duration = formatDuration(item.durationMs);
  // 失败 tooltip 与展开区喂同一份尾部逻辑（ticket：错误详情取 stderr/输出尾部）：
  // 骨架的 FailedDetailPopover 再做 2000 字符级裁剪，双层收敛后仍以最后一行结尾。
  const failureDetail = failed
    ? truncateOutputTail(item.aggregatedOutput).text || item.status
    : null;

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<SquareTerminal size={11} />}
      category={t("codex.tool.category.command")}
      text={item.command}
      status={status}
      statusLabel={item.exitCode !== null && item.exitCode !== 0 ? `exit ${item.exitCode}` : undefined}
      failureDetail={failureDetail}
      collapsible={hasOutput}
      autoExpandWhileRunning
      autoCollapseOnDone
      streamingRevision={revision}
      meta={
        <>
          {item.exitCode !== null && item.exitCode !== 0 && (
            <span style={s.codexToolMetaError}>exit {item.exitCode}</span>
          )}
          {running && startedAtMs != null ? (
            <span style={s.codexToolMeta}>
              <CodexLiveDuration startedAtMs={startedAtMs} endedAtMs={endedAtMs} />
            </span>
          ) : (
            duration && <span style={s.codexToolMeta}>{duration}</span>
          )}
        </>
      }
    >
      <CommandOutputBody
        output={item.aggregatedOutput}
        copyLabel={t("common.copy")}
        copiedLabel={t("codex.tool.copied")}
        truncatedLabel={t("codex.output.truncatedTail")}
      />
    </CodexToolCard>
  );
});

/** 命令输出体：尾部截断渲染 + 截断提示 + 复制全文按钮。 */
function CommandOutputBody({
  output,
  copyLabel,
  copiedLabel,
  truncatedLabel,
}: {
  output: string | null;
  copyLabel: string;
  copiedLabel: string;
  truncatedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!output) return null;

  const tail = truncateOutputTail(output);

  const handleCopy = () => {
    // 全量输出始终在内存条目上——复制的永远是完整文本（user story 15）
    navigator.clipboard.writeText(output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={s.codexCommandOutputWrap}>
      {tail.truncated && (
        <div style={s.codexCommandTruncationNote} data-testid="codex-output-truncated-note">
          <span>
            {truncatedLabel
              .replace("{lines}", String(tail.omittedLines))
              .replace("{total}", String(tail.totalLines))}
          </span>
          <button
            type="button"
            className="codex-stream-copy-btn"
            title={copied ? copiedLabel : copyLabel}
            aria-label={copyLabel}
            onClick={handleCopy}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}
      <pre style={s.codexEntryBody} data-testid="codex-command-output-pre">
        {tail.text}
      </pre>
      {!tail.truncated && (
        <button
          type="button"
          className="codex-stream-copy-btn"
          title={copied ? copiedLabel : copyLabel}
          aria-label={copyLabel}
          onClick={handleCopy}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}
