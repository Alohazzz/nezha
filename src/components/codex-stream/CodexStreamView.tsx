import { memo, useEffect, useMemo, useRef } from "react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { CodexHistoryStatus, CodexStreamEntry } from "../../hooks/useCodexStream";
import type { CodexTokenUsage, CodexUserInputRequest } from "../../types";
import type { AgentModelCatalog } from "../app-settings/types";
import { CodexApprovalCard } from "./CodexApprovalCard";
import { CodexQuestionCard } from "./CodexQuestionCard";
import { CodexComposer } from "./CodexComposer";
import { CodexWorkingIndicator } from "./CodexWorkingIndicator";
import { CodexTurnSection } from "./CodexTurnSection";
import { CodexTurnFooter } from "./CodexTurnFooter";
import { CodexCommandGroupEntry } from "./CodexCommandGroupEntry";
import { CodexEntry } from "./codexRenderers";
import { segmentTurnEntries } from "./codexTurnSegments";
import { summarizeCodexStream } from "./codexStreamSummary";
import { CodexStreamProjectContext, CodexStreamTurnActiveContext } from "./codexStreamContext";

/** usage 条：总 token + 上下文窗口占用（tokenUsage 帧驱动）。
 * 填充条宽度为动态百分比，经 ref 写 CSS 变量（规范禁 inline style 对象）。
 * 上下文占用取 `last.totalTokens`（最近一次 API 调用的活跃上下文）；
 * `total` 是整场累计（每轮重发历史会被重复计入），只用于展示累计值。 */
const UsageBar = memo(function UsageBar({ usage }: { usage: CodexTokenUsage | null }) {
  const { t } = useI18n();
  const fillRef = useRef<HTMLDivElement | null>(null);
  if (!usage) return null;
  const total = usage.total;
  const ctxWindow = usage.modelContextWindow;
  const ctxUsed = usage.last.totalTokens;

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
  onOpenLink,
  entryIndex,
}: {
  entry: CodexStreamEntry;
  onOpenGitChanges?: () => void;
  onOpenLink?: (href: string) => void;
  entryIndex?: number;
}) {
  return (
    <CodexEntry
      entry={entry}
      onOpenGitChanges={onOpenGitChanges}
      onOpenLink={onOpenLink}
      entryIndex={entryIndex}
    />
  );
}

/** 顶层条目流是否还有「不属于任何轮」的内容（会话从助手侧开始 / 续跑回放）。
 *  这类条目没有用户输入可依，仍按平铺渲染——塞进折叠段会藏起用户没发起的动作。 */

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
  history,
  approval,
  onApprovalResolved,
  userInput,
  onUserInputResolved,
  running,
  statusText,
  statusTone = "warning",
  /** 本轮开始时刻（毫秒）：流尾「工作中」指示器的计时锚点，随任务数据持久，
   *  切页面重挂载不归零；缺省回落指示器挂载时刻（旧行为）。 */
  turnStartedAtMs,
  followUpBusy,
  composerDisabled,
  projectPath,
  onComposerSubmit,
  onImageToast,
  onOpenGitChanges,
  onOpenLink,
  modelCatalog,
  model,
  reasoningEffort,
  showModelBadge,
  onSetStructuredModel,
  onBuiltinAction,
}: {
  entries: CodexStreamEntry[];
  usage: CodexTokenUsage | null;
  /** 历史回放状态：区分「历史还在读」/「会话文件读失败」/「真的没有记录」。
   *  缺省按 idle 处理（纯实时视图）。 */
  history?: CodexHistoryStatus;
  approval: Parameters<typeof CodexApprovalCard>[0]["request"] | null;
  onApprovalResolved: () => void;
  running: boolean;
  statusText?: string | null;
  /** 横幅语义色：失败 = error（红），中断 / 断开 = warning（黄）。 */
  statusTone?: "error" | "warning";
  /** 本轮开始时刻（毫秒）；仅用于流尾「工作中」指示器的计时锚点。 */
  turnStartedAtMs?: number | null;
  /** composer 提交回调：running 态走 steer、其余走 resume（App 层分发）。
   *  images 为 dataUrl 数组（issue #118：粘贴/选择图片随消息发送）。 */
  onComposerSubmit?: (text: string, images: string[]) => void;
  followUpBusy?: boolean;
  /** 审批挂起等 composer 不该受理输入的场景置真（Paseo 同款：审批卡优先）。 */
  composerDisabled?: boolean;
  /** 项目根路径：透传给 composer 的 `$`/`/`/`@` 快捷召唤；同时经 context 下发
   *  给条目渲染层（userMessage 气泡 localImage 缩略图的 read_image_preview）。 */
  projectPath?: string;
  /** composer 图片拒收（超限等）的提示通道（RunningView 接 showToast）。 */
  onImageToast?: (message: string, kind: "warning" | "error") => void;
  /** 截断 diff → GitChanges 右面板的跳转入口（openRightPanel("git-changes")）。 */
  onOpenGitChanges?: () => void;
  /** agent 消息正文链接点击委托（沉淀文档在应用内打开 / 外链走系统浏览器）。 */
  onOpenLink?: (href: string) => void;
  /** `/model` `/effort` 内置命令支撑：目录 + 当前值 + 写入通道（App 层落 RPC）。 */
  modelCatalog?: AgentModelCatalog;
  model?: string;
  reasoningEffort?: string;
  showModelBadge?: boolean;
  onSetStructuredModel?: (model: string | undefined, effort: string | undefined) => void;
  /** 非选择器类内置命令动作（/compact /review /stop；App 层落 RPC / 中断）。 */
  onBuiltinAction?: (action: "compact" | "review" | "stop") => void;
  /** 模型提问（`request_user_input`）：非空时底部渲染问答卡片。 */
  userInput?: CodexUserInputRequest | null;
  onUserInputResolved?: () => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // 失败/中断类状态是必须第一眼看到的收口信息。**必须钉在滚动区外**：
  // 早先把它作为流首行渲染，几百条条目之后失败横幅早被滚出视野，任务看起来
  // 像"假死或正常结束"。这里改为滚动区上方的常驻横幅。
  const bannerText = statusText ?? null;
  const showEmptyHint = entries.length === 0 && !bannerText;
  // 空态三态化：历史任务打开时会先从 rollout 回放，直接喊「没有记录」是错的。
  const historyLoading = showEmptyHint && history?.state === "loading";
  const historyFailureReason =
    showEmptyHint && history?.state === "failed" ? history.reason : null;

  // 轮次分段（对标 ZCode）：一条用户输入开启一轮，过程收进折叠段，结论留在主线。
  // 纯函数 + useMemo：entries 每次增量都会换引用，只在真正变化时重算。
  // 第一条用户消息之前的条目作为「无主条目」平铺渲染（会话从助手侧开始 /
  // 冷恢复续跑）——用户没发起过这些动作，藏进折叠区就成了凭空出现的内容。
  const interrupted = !running && statusTone === "warning" && bannerText !== null;
  const { segments, orphanItems } = useMemo(
    () => segmentTurnEntries(entries, { running, interrupted }),
    [entries, running, interrupted],
  );
  const summary = useMemo(() => summarizeCodexStream(entries, segments), [entries, segments]);
  // 运行中的段若有过程，折叠头的「正在工作 · N 秒」就是活性信号；只有在还没
  // 攒出任何过程（刚发指令、模型还在想）时才需要流尾兜底指示。
  const activeSegment = segments[segments.length - 1];
  const needsWorkingIndicator =
    running && (!activeSegment || activeSegment.processItems.length === 0);

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

  const renderItem = (item: (typeof orphanItems)[number], i: number) =>
    item.kind === "commandGroup" ? (
      <CodexCommandGroupEntry
        key={item.groupKey}
        groupKey={item.groupKey}
        commands={item.commands}
      />
    ) : (
      <EntryRenderer
        key={(item.entry.item && "id" in item.entry.item && item.entry.item.id) || `idx-${i}`}
        entry={item.entry}
        entryIndex={item.entryIndex}
        onOpenGitChanges={onOpenGitChanges}
        onOpenLink={onOpenLink}
      />
    );

  return (
    <CodexStreamProjectContext.Provider value={projectPath ?? null}>
      <CodexStreamTurnActiveContext.Provider value={running}>
        <div style={s.codexStreamViewRoot}>
          {/* 终端态横幅在滚动区之上且不随内容滚动——失败原因必须常驻可见。 */}
          {bannerText && (
            <div className="codex-stream-banner" role="status" data-tone={statusTone}>
              <span className="codex-stream-banner-icon" aria-hidden="true" />
              <span className="codex-stream-banner-text">{bannerText}</span>
            </div>
          )}
          <div ref={scrollRef} style={s.codexStreamRoot} onScroll={handleScroll}>
            {showEmptyHint && (
              <div style={s.codexStreamEmpty}>
                {historyLoading
                  ? t("codex.stream.historyLoading")
                  : historyFailureReason !== null
                    ? t("codex.stream.historyFailed", { error: historyFailureReason })
                    : running
                      ? t("codex.stream.waitingFirst")
                      : t("codex.stream.empty")}
              </div>
            )}
            {/* 无主条目（会话从助手侧开始）按平铺渲染，不进任何折叠段。 */}
            {orphanItems.map(renderItem)}
            {segments.map((segment) => (
              <CodexTurnSection
                key={segment.key}
                segment={segment}
                onOpenGitChanges={onOpenGitChanges}
                onOpenLink={onOpenLink}
              />
            ))}
            {/* 整轮活性指示：仅在还没有任何过程时使用（刚发指令、模型还在想）。
                一旦折叠头出现，它就是唯一计时来源——两处各起一个计数器会给出
                两个互相矛盾的秒数。锚点优先活跃段的 startedAtMs（随流数据持久），
                无段时回落任务级 turnStartedAtMs（进入 running 时刻）。 */}
            {running && !bannerText && needsWorkingIndicator && (
              <CodexWorkingIndicator
                startedAtMs={activeSegment?.startedAtMs ?? turnStartedAtMs ?? null}
              />
            )}
            {/* 轮尾收口：结束的那一刻必须能一眼看出「结束了、花了多久、改了什么」。
                此前只有失败才有横幅，正常结束的流视图走到最后一条工具卡就停住。 */}
            {!running && entries.length > 0 && (
              <CodexTurnFooter
                summary={summary}
                failed={statusTone === "error"}
                interrupted={statusTone === "warning" && bannerText !== null}
                statusText={bannerText}
              />
            )}
            {/* 提问优先于审批：提问会阻塞 turn，而审批只是拒绝一条命令。
                两者同时挂起时只渲染提问，避免两张 sticky 卡片叠在一起。 */}
            {userInput ? (
              <CodexQuestionCard
                request={userInput}
                onResolved={() => onUserInputResolved?.()}
                onError={(message) => onImageToast?.(message, "error")}
              />
            ) : (
              approval && <CodexApprovalCard request={approval} onResolved={onApprovalResolved} />
            )}
          </div>
          {onComposerSubmit && (
            <CodexComposer
              mode={running ? "steer" : "resume"}
              busy={followUpBusy}
              disabled={composerDisabled}
              projectPath={projectPath}
              modelCatalog={modelCatalog}
              model={model}
              reasoningEffort={reasoningEffort}
              showModelBadge={showModelBadge}
              onSubmit={onComposerSubmit}
              onSetModel={
                onSetStructuredModel ? (next) => onSetStructuredModel(next, reasoningEffort) : undefined
              }
              onSetEffort={
                onSetStructuredModel ? (next) => onSetStructuredModel(model, next) : undefined
              }
              onBuiltinAction={onBuiltinAction}
              onToast={onImageToast}
            />
          )}
          <UsageBar usage={usage} />
        </div>
      </CodexStreamTurnActiveContext.Provider>
    </CodexStreamProjectContext.Provider>
  );
}
