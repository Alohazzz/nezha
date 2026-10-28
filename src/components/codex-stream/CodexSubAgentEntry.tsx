import { memo } from "react";
import { Bot } from "lucide-react";
import type { CodexSubAgentActivityItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard, type CodexToolStatus } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { formatDuration } from "./codexEntryShared";
import { useCodexStreamTurnActive } from "./codexStreamContext";

// 子智能体生命周期卡（上游 `ThreadItem::SubAgentActivity`）。
//
// 设计参照 ZCode 的 Agent 摘要行：父对话里子智能体只占**一行**，重点是让人
// 一眼看出「起来了没有 / 还在跑 / 已经结束」，细节不摊开。所以：
// - 摘要行主文本 = 智能体路径（`/root/worker`），比 thread id 可读；
// - 状态词显式给出「运行中 / 已完成 / 已中断」，运行中带跳动秒数——这是此前缺失
//   的关键信号（兜底卡只有一个静态 JSON，看起来像什么都没发生）；
// - 展开区只放身份与模型，不放原始 JSON：`interacted` 之类噪音由归并层折叠。
//
// kind 语义对齐上游 TUI（multi_agents.rs）：started = 运行中，completed /
// interrupted = 终态；未知 kind 按运行中处理，避免新枚举值把卡片误画成已完成。

/** 已知 kind → 词条后缀；未知 kind 一律按运行中，绝不把还在跑的智能体
 *  画成已完成（这正是本次要修的观感问题）。 */
function statusKeyOf(kind: string): "running" | "completed" | "interrupted" {
  if (kind === "completed") return "completed";
  if (kind === "interrupted") return "interrupted";
  return "running";
}

/** 上游 kind → 卡片状态语义色。interrupted 是终态但非正常结束，按失败呈现。 */
function toneOf(kind: string): CodexToolStatus {
  if (kind === "completed") return "ok";
  if (kind === "interrupted") return "failed";
  return "running";
}

export const CodexSubAgentEntry = memo(function CodexSubAgentEntry({
  item,
  startedAtMs,
  endedAtMs,
}: {
  item: CodexSubAgentActivityItem;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}) {
  const { t } = useI18n();
  const turnActive = useCodexStreamTurnActive();
  const rawKey = statusKeyOf(item.kind);
  const rawStatus = toneOf(item.kind);
  // 整轮已结束但子智能体始终没发终态事件（被取消 / 进程退出 / 事件丢失）：
  // 不能继续显示「运行中」——界面还在转、任务其实已经结束了，正是要修的观感。
  // 降级成中性的「无终态」而不是「已完成」：结束原因未知，不能假装正常跑完。
  const stale = rawKey === "running" && !turnActive;
  const status: CodexToolStatus = stale ? "ok" : rawStatus;
  const statusKey = stale ? "ended" : rawKey;
  const running = status === "running";

  // 智能体名：agentPath 是权威来源；缺省（旧记录）时退回短 thread id，
  // 保证摘要行永远有可辨识的标签，不会退化成空白卡。
  const agentPath = typeof item.agentPath === "string" ? item.agentPath.trim() : "";
  const shortId =
    typeof item.agentThreadId === "string" && item.agentThreadId.length > 8
      ? item.agentThreadId.slice(-8)
      : item.agentThreadId;
  const agentName = agentPath || shortId || item.id;

  const duration = formatDuration(
    typeof startedAtMs === "number" && typeof endedAtMs === "number"
      ? endedAtMs - startedAtMs
      : null,
  );

  const modelLabel = typeof item.model === "string" ? item.model.trim() : "";
  const effortLabel = typeof item.reasoningEffort === "string" ? item.reasoningEffort.trim() : "";
  const hasBody = Boolean(modelLabel || item.agentPath || item.agentThreadId);

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<Bot size={11} />}
      category={t("codex.tool.category.subAgent")}
      text={agentName}
      status={status}
      // 状态词用活动语义而非通用「完成」：子智能体的 completed 是它自己跑完了，
      // 不是父任务做完了，两者混用正是让人分不清结束与否的原因。
      statusLabel={t(`codex.subAgent.kind.${statusKey}`)}
      collapsible={hasBody}
      // 运行中不自动展开：这一行本身就是状态指示，展开反而挡住上下文。
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
      meta={
        running && startedAtMs != null ? (
          <span style={s.codexToolMeta}>
            <CodexLiveDuration startedAtMs={startedAtMs} endedAtMs={endedAtMs} />
          </span>
        ) : duration ? (
          <span style={s.codexToolMeta}>{duration}</span>
        ) : null
      }
    >
      <div style={s.codexEntrySection}>
        <div style={s.codexEntrySectionLabel}>{t("codex.subAgent.identity")}</div>
        <div className="codex-stream-subagent-row">
          <span className="codex-stream-subagent-key">{t("codex.subAgent.path")}</span>
          <span className="codex-stream-subagent-value">{agentPath || "—"}</span>
        </div>
        <div className="codex-stream-subagent-row">
          <span className="codex-stream-subagent-key">{t("codex.subAgent.thread")}</span>
          <span className="codex-stream-subagent-value">{item.agentThreadId || "—"}</span>
        </div>
        {modelLabel && (
          <div className="codex-stream-subagent-row">
            <span className="codex-stream-subagent-key">{t("codex.subAgent.model")}</span>
            <span className="codex-stream-subagent-value">
              {effortLabel ? `${modelLabel} · ${effortLabel}` : modelLabel}
            </span>
          </div>
        )}
      </div>
    </CodexToolCard>
  );
});
