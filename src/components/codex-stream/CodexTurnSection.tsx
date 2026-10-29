import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexEntry } from "./codexRenderers";
import { CodexCommandGroupEntry } from "./CodexCommandGroupEntry";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { CodexWorkingIndicator } from "./CodexWorkingIndicator";
import { formatWorkDuration } from "./codexDuration";
import type { CodexTurnSegment } from "./codexTurnSegments";

// ── 轮次段（对标 ZCode ConversationWorkSegmentFlow + AssistantHistoryStatus）───
//
// 一轮 = 一条用户输入 + 它引发的全部动作。渲染分三层：
//   1. 用户气泡（这一轮要什么，永远可见）；
//   2. 「已工作 10 分 59 秒」折叠头 + 过程区（命令 / 思考 / 中间叙述）；
//   3. 结论（轮结束后提升出来，常驻可见）。
//
// 为什么过程默认收起：过程是**诊断信息**，不是结果。平铺时一屏工具日志把结论
// 挤出视口，任务结束那一刻看到的是最后一条命令而不是「做完了什么」。运行中
// 相反——实况必须可见，所以上一轮结束、新一轮开始时自动收起，运行中的段自动
// 展开（段组件的 defaultOpen 边沿）。
//
// 与 ZCode 的差异：ZCode 一轮里可能有多段（guide 引导消息再切段），这里同样
// 以用户消息为界切段，因此每段只有一条结论，不存在跨段正文拼接问题。

/** 过程折叠头：状态词 + 时长 + 展开箭头。运行中时长走动态跳动秒数。 */
function ProcessHeader({
  segment,
  open,
  onToggle,
}: {
  segment: CodexTurnSegment;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const running = segment.state === "running";  // 时长只在起止都有值时才给：只有起点时用 Date.now() 兜底会让历史段每次都
  // 重新计算，静置一小时后再看历史，「已工作」就自己长大了。
  const duration =
    !running && segment.startedAtMs !== null && segment.endedAtMs !== null
      ? formatWorkDuration(t, segment.endedAtMs - segment.startedAtMs)
      : null;

  const label = running
    ? t("codex.turn.working")
    : segment.state === "interrupted"
      ? t("codex.turn.stopped")
      : duration
        ? t("codex.turn.worked", { duration })
        : t("codex.turn.workedNoDuration");

  return (
    <button
      type="button"
      className="codex-stream-turn-header"
      data-open={open || undefined}
      data-state={segment.state}
      onClick={onToggle}
      aria-expanded={open}
    >
      <ChevronRight size={11} className="codex-stream-turn-chevron" data-open={open || undefined} />
      <span className="codex-stream-turn-label">{label}</span>
      {/* 运行中的跳动秒数接在同一句里（「工作中 · 12s」），不单独再占一个槽位——
          同一行出现「工作中」和裸秒数两段，等于把同一件事说了两遍。 */}
      {running && segment.startedAtMs != null && (
        <>
          <span className="codex-stream-turn-sep" aria-hidden="true">
            ·
          </span>
          <span style={s.codexToolMeta}>
            <CodexLiveDuration startedAtMs={segment.startedAtMs} endedAtMs={null} />
          </span>
        </>
      )}
    </button>
  );
}

export const CodexTurnSection = memo(function CodexTurnSection({
  segment,
  onOpenGitChanges,
  onOpenLink,
}: {
  segment: CodexTurnSegment;
  onOpenGitChanges?: () => void;
  onOpenLink?: (href: string) => void;
}) {
  const { t } = useI18n();
  // 折叠态跟随 segment.defaultOpen，但只在边沿切换时改——运行中每帧重渲染
  // 不能覆盖用户的手动展开（与 CodexToolCard 的手动优先同款规则）。
  const [open, setOpen] = useState(segment.defaultOpen);
  const manualRef = useRef(false);
  const prevDefaultRef = useRef(segment.defaultOpen);

  useEffect(() => {
    if (prevDefaultRef.current === segment.defaultOpen) return;
    prevDefaultRef.current = segment.defaultOpen;
    if (manualRef.current) return;
    setOpen(segment.defaultOpen);
  }, [segment.defaultOpen]);

  const handleToggle = useCallback(() => {
    manualRef.current = true;
    setOpen((prev) => !prev);
  }, []);

  const hasProcess = segment.processItems.length > 0;
  // 没有过程（用户提问后直接给答复）不渲染折叠头——一行「已工作 2 秒」加箭头
  // 点开是空的，纯粹噪音。
  const showHeader = hasProcess;
  // 计划 / 图片本身就是交付物：这类轮次即便没写最终叙述，也不算「没有答复」。
  const hasDeliverableInProcess = segment.processItems.some(
    (item) => item.kind === "entry" && (item.entry.kind === "plan" || item.entry.kind === "imageView"),
  );

  return (
    <section className="codex-stream-turn" data-state={segment.state}>
      {segment.userMessage && (
        <CodexEntry entry={segment.userMessage} onOpenGitChanges={onOpenGitChanges} onOpenLink={onOpenLink} />
      )}
      {showHeader && <ProcessHeader segment={segment} open={open} onToggle={handleToggle} />}
      {showHeader && open && (
        <div className="codex-stream-turn-process" data-testid="codex-turn-process">
          {segment.processItems.map((item, i) =>
            item.kind === "commandGroup" ? (
              <CodexCommandGroupEntry
                key={item.groupKey}
                groupKey={item.groupKey}
                commands={item.commands}
              />
            ) : (
              <CodexEntry
                key={
                  (item.entry.item && "id" in item.entry.item && item.entry.item.id) ||
                  `idx-${item.entryIndex || i}`
                }
                entry={item.entry}
                entryIndex={item.entryIndex}
                onOpenGitChanges={onOpenGitChanges}
                onOpenLink={onOpenLink}
              />
            ),
          )}
          {/* 长命令 / 长思考的 delta 静默期：最后一行内容可能十几分钟不动，
              折叠头的跳动秒数又离视线落点太远。段内末尾的旋转 spinner 是
              「还在跑」的就近信号（ZCode 段内 loading 同款）；轮一结束即卸载。 */}
          {segment.state === "running" && (
            <CodexWorkingIndicator
              variant="inline"
              startedAtMs={segment.startedAtMs}
            />
          )}
        </div>
      )}
      {/* 结论：过程收起时它才是这一轮唯一可见的结果。 */}
      {segment.answer && (
        <CodexEntry entry={segment.answer} onOpenGitChanges={onOpenGitChanges} onOpenLink={onOpenLink} />
      )}
      {/* 本轮有过程但没留下任何结论：明确写出来，别让空白被误读成「正常完成」。
          计划 / 图片这类条目本身就是交付物，不该被判定成「没答复」。 */}
      {!segment.answer && segment.state === "completed" && hasProcess && !hasDeliverableInProcess && (
        <div className="codex-stream-turn-empty-answer" data-testid="codex-turn-empty-answer">
          {t("codex.turn.noAnswer")}
        </div>
      )}
    </section>
  );
});
