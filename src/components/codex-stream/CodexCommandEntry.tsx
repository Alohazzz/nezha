import { memo, useState } from "react";
import { Check, Copy, SquareTerminal } from "lucide-react";
import type { CodexCommandExecutionItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard, FailedDetailPopover } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { formatDuration, truncateOutputTail } from "./codexEntryShared";
import { summarizeCommand } from "./codexCommandSummary";

// 命令执行卡（issue #117 T3 自 CodexEntryItems 迁出；T5 接尾部截断；#119 补
// 运行中动态秒数）：骨架管行为（折叠持久 / 自动边沿 / 失败 tooltip），本卡只管
// 内容渲染。行为矩阵：默认收起、流式中自动展开、完成自动收起。展开区只渲染
// 输出尾部（~64KB、按整行取尾，spec user story 15）；全量输出保留在内存条目上，
// 复制全文按钮复制完整文本。
// 运行中 meta 由 CodexLiveDuration 以条目 startedAtMs 起跳；完成后以权威
// durationMs 替换（spec user story 8/9）。
//
// 密集度改版：摘要行渲染**剥离 shell 包裹**后的真实命令（原始命令完整留在
// 展开区），不渲染成功/运行中的状态词，meta 只保留一条语义（耗时 或 红色
// exit 码），避免同一行出现「exit 127 · 失败 · 1.5s」三份重复信息。
// compact 供聚合组内的子行使用：省略图标与类别词。

export const CodexCommandEntry = memo(function CodexCommandEntry({
  item,
  revision,
  startedAtMs,
  endedAtMs,
  compact = false,
  showStatus = false,
}: {
  item: CodexCommandExecutionItem;
  /** T1 归并层的条目修订号（输出 delta 递增），驱动骨架自动展开边沿。 */
  revision?: number;
  /** 归并层条目时间戳（#119）：running 时动态计时起点。 */
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  /** 紧凑形态（聚合组子行）：省略图标与类别词，靠组壳左侧竖线表达层级。 */
  compact?: boolean;
  /** 是否渲染状态词；默认 false（命令行的成功/运行中状态由命令文本与耗时表达）。 */
  showStatus?: boolean;
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
  const exitCode = item.exitCode !== null && item.exitCode !== 0 ? item.exitCode : null;

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<SquareTerminal size={11} />}
      category={t("codex.tool.category.command")}
      text={summarizeCommand(item.command)}
      status={status}
      showStatus={showStatus}
      compact={compact}
      failureDetail={failureDetail}
      collapsible={hasOutput}
      autoExpandWhileRunning
      autoCollapseOnDone
      streamingRevision={revision}
      meta={
        // 单段 meta：失败只留红色 exit 码（它同时是失败详情入口），成功只留耗时。
        // 失败但无 exit code（declined / 进程被杀）时退回红色状态词——否则这条
        // 命令在摘要行上完全看不出失败。
        exitCode !== null ? (
          failureDetail ? (
            <FailedDetailPopover detail={failureDetail} label={`exit ${exitCode}`} />
          ) : (
            <span style={s.codexToolMetaError}>exit {exitCode}</span>
          )
        ) : failed ? (
          failureDetail ? (
            <FailedDetailPopover detail={failureDetail} label={t("codex.tool.failed")} />
          ) : (
            <span style={s.codexToolMetaError}>{t("codex.tool.failed")}</span>
          )
        ) : running && startedAtMs != null ? (
          <span style={s.codexToolMeta}>
            <CodexLiveDuration startedAtMs={startedAtMs} endedAtMs={endedAtMs} />
          </span>
        ) : (
          duration && <span style={s.codexToolMeta}>{duration}</span>
        )
      }
    >
      <CommandOutputBody
        command={item.command}
        output={item.aggregatedOutput}
        copyLabel={t("common.copy")}
        copiedLabel={t("codex.tool.copied")}
        truncatedLabel={t("codex.output.truncatedTail")}
      />
    </CodexToolCard>
  );
});

/** 命令输出体：完整命令 + 尾部截断输出 + 截断提示 + 复制全文按钮。 */
function CommandOutputBody({
  command,
  output,
  copyLabel,
  copiedLabel,
  truncatedLabel,
}: {
  command: string;
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
      {/* 摘要行只显示剥离包裹后的命令，这里给出可完整复制的原始命令 */}
      <pre style={s.codexCommandFull} data-testid="codex-command-full">
        {command}
      </pre>
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
