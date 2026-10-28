import { memo } from "react";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { useI18n } from "../../i18n";
import { formatWorkDuration } from "./codexDuration";
import type { CodexStreamSummary } from "./codexStreamSummary";

// ── 轮尾收口页脚（对标 ZCode ConversationFileSummaryPanel + 轮尾状态行）──────
//
// 此前「任务完成了」这个事实只存在于顶部横幅，而横幅只在失败 / 中断时出现——
// 正常结束时流视图走到最后一条工具卡就停住，看不出「结束了」「花了多久」
// 「改了什么」。这里在滚动区末尾补一条收口行：状态 + 时长 + 命令数 + 改动文件。
//
// 只在本轮已结束时渲染；运行中尾部是「工作中 N 秒」活性指示（另一个组件）。

export const CodexTurnFooter = memo(function CodexTurnFooter({
  summary,
  failed,
  interrupted,
  statusText,
}: {
  summary: CodexStreamSummary;
  /** 任务终态是否失败（有 statusText 且 tone=error 时由调用方传入）。 */
  failed: boolean;
  interrupted: boolean;
  /** 收口文案（失败原因 / 已停止）：失败时必须原文透传，不吞掉上游原因。 */
  statusText?: string | null;
}) {
  const { t } = useI18n();
  const duration = formatWorkDuration(t, summary.workMs);

  const state = failed ? "failed" : interrupted ? "interrupted" : "done";
  const label = failed
    ? t("codex.stream.footerFailed")
    : interrupted
      ? t("codex.stream.footerStopped")
      : duration
        ? t("codex.stream.footerDone", { duration })
        : t("codex.stream.footerDoneNoDuration");

  return (
    <div className="codex-stream-footer" data-state={state} role="status">
      <span className="codex-stream-footer-icon" aria-hidden="true">
        {failed ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}
      </span>
      <span className="codex-stream-footer-label">{label}</span>
      <span className="codex-stream-footer-stats">
        {summary.commands > 0 && (
          <span>{t("codex.stream.footerCommands", { count: summary.commands })}</span>
        )}
        {summary.filesChanged > 0 && (
          <span>{t("codex.stream.footerFiles", { count: summary.filesChanged })}</span>
        )}
        {summary.failures > 0 && (
          <span data-tone="failed">{t("codex.stream.footerFailures", { count: summary.failures })}</span>
        )}
      </span>
      {/* 失败原因可能多行（上游 TurnError.message）：换行渲染，不截断。 */}
      {failed && statusText && (
        <div className="codex-stream-footer-reason" data-testid="codex-stream-footer-reason">
          {statusText}
        </div>
      )}
    </div>
  );
});
