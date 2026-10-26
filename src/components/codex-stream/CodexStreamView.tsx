import { memo, useEffect, useRef } from "react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { CodexStreamEntry } from "../../hooks/useCodexStream";
import type { CodexTokenUsage } from "../../types";
import { codexEntryRenderers } from "./codexRenderers";
import { CodexApprovalCard } from "./CodexApprovalCard";
import { CodexComposer } from "./CodexComposer";

/** usage 条：总 token + 上下文窗口占用（tokenUsage 帧驱动）。
 * 填充条宽度为动态百分比，经 ref 写 CSS 变量（规范禁 inline style 对象）。 */
const UsageBar = memo(function UsageBar({ usage }: { usage: CodexTokenUsage | null }) {
  const { t } = useI18n();
  const fillRef = useRef<HTMLDivElement | null>(null);
  if (!usage) return null;
  const total = usage.total;
  const ctxWindow = usage.modelContextWindow;
  const ctxUsed = total.inputTokens + total.outputTokens;

  const fmt = (n: number) => {
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
  };

  const ctxPercent =
    ctxWindow && ctxWindow > 0 ? Math.min(100, Math.round((ctxUsed / ctxWindow) * 100)) : null;

  const writeFillWidth = (el: HTMLDivElement | null) => {
    fillRef.current = el;
    if (el && ctxPercent !== null) el.style.setProperty("width", `${ctxPercent}%`);
  };

  return (
    <div style={s.codexUsageBar}>
      <span>
        {t("running.tokens")} {fmt(total.totalTokens)}
      </span>
      {ctxPercent !== null && (
        <>
          <div style={s.codexUsageMeter}>
            <div ref={writeFillWidth} className="codex-stream-usage-fill" data-warn={ctxPercent > 80 || undefined} />
          </div>
          <span>
            {t("running.context")} {fmt(ctxUsed)} / {fmt(ctxWindow!)} ({ctxPercent}%)
          </span>
        </>
      )}
    </div>
  );
});

function EntryRenderer({
  entry,
  onOpenGitChanges,
  entryIndex,
}: {
  entry: CodexStreamEntry;
  onOpenGitChanges?: () => void;
  entryIndex?: number;
}) {
  const render = codexEntryRenderers[entry.kind];
  return <>{render({ entry, onOpenGitChanges, entryIndex })}</>;
}

/**
 * structured 任务实时流视图（issue #116 阶段 3；#117 T3 起条目渲染经
 * codexRenderers 注册表分发）。数据由 `useCodexStream`（App 层接线 Channel）
 * 喂入；本组件只负责渲染 + 跟随滚动 + 审批卡片置底。Paseo 式布局：消息流
 * 滚动区在上，composer 固定底部（运行中 = steer，done = resume），usage 条
 * 垫在 composer 下。
 */
export function CodexStreamView({
  entries,
  usage,
  approval,
  onApprovalResolved,
  running,
  statusText,
  followUpBusy,
  composerDisabled,
  onComposerSubmit,
  onOpenGitChanges,
}: {
  entries: CodexStreamEntry[];
  usage: CodexTokenUsage | null;
  approval: Parameters<typeof CodexApprovalCard>[0]["request"] | null;
  onApprovalResolved: () => void;
  running: boolean;
  statusText?: string | null;
  /** composer 提交回调：running 态走 steer、其余走 resume（App 层分发）。 */
  onComposerSubmit?: (text: string) => void;
  followUpBusy?: boolean;
  /** 审批挂起等 composer 不该受理输入的场景置真（Paseo 同款：审批卡优先）。 */
  composerDisabled?: boolean;
  /** 截断 diff → GitChanges 右面板的跳转入口（openRightPanel("git-changes")）。 */
  onOpenGitChanges?: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // 用户主动上滚即停止跟随；滚回底部恢复跟随（终端自动滚动同款交互）
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  return (
    <div style={s.codexStreamViewRoot}>
      <div ref={scrollRef} style={s.codexStreamRoot} onScroll={handleScroll}>
        {entries.length === 0 && !statusText && (
          <div style={s.codexStreamEmpty}>
            {running ? t("codex.stream.waitingFirst") : t("codex.stream.empty")}
          </div>
        )}
        {entries.map((entry, i) => (
          <EntryRenderer
            key={(entry.item && "id" in entry.item && entry.item.id) || `idx-${i}`}
            entry={entry}
            entryIndex={i}
            onOpenGitChanges={onOpenGitChanges}
          />
        ))}
        {statusText && <div style={s.codexStreamEmpty}>{statusText}</div>}
        {approval && <CodexApprovalCard request={approval} onResolved={onApprovalResolved} />}
      </div>
      {onComposerSubmit && (
        <CodexComposer
          mode={running ? "steer" : "resume"}
          busy={followUpBusy}
          disabled={composerDisabled}
          onSubmit={onComposerSubmit}
        />
      )}
      <UsageBar usage={usage} />
    </div>
  );
}
