import { memo } from "react";
import { Users } from "lucide-react";
import type {
  CodexAgentStateLike,
  CodexCollabAgentToolCallItem,
  CodexCollabTool,
} from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexLiveDuration } from "./CodexLiveDuration";
import { formatDuration } from "./codexEntryShared";

// 多智能体协作调用卡（上游 `CollabAgentToolCall`：spawnAgent / wait / sendInput /
// listAgents 等）。这类条目此前没有渲染器，落到 fallback 兜底卡里只显示一坨原始
// JSON——尤其 `wait` 超时后回传的 `{status:"inProgress"}` 快照看起来像报错。
//
// 摘要行语义：类别固定「协作」，主文本是中文动作词（等待 / 派发子智能体 …），
// meta 给目标数量与耗时；展开区展示下发的提示词与每个目标智能体的状态。
// 行为矩阵与思考卡一致：默认收起、不自动展开 / 完成不自动收起。
//
// 注意 status 缺省：started 帧缺失（回放 / 乱序）时上游可能只给 inProgress 快照，
// 统一按运行中处理，不要让卡片因缺字段渲染成「完成」。

const COLLAB_TOOL_LABEL_KEY: Record<CodexCollabTool, string> = {
  spawnAgent: "codex.collab.tool.spawnAgent",
  sendInput: "codex.collab.tool.sendInput",
  resumeAgent: "codex.collab.tool.resumeAgent",
  wait: "codex.collab.tool.wait",
  closeAgent: "codex.collab.tool.closeAgent",
  sendMessage: "codex.collab.tool.sendMessage",
  followupTask: "codex.collab.tool.followupTask",
  interruptAgent: "codex.collab.tool.interruptAgent",
  listAgents: "codex.collab.tool.listAgents",
};

/** agentsStates 的键是子智能体 thread id：末 8 位足够在同一张卡里区分。 */
function shortThreadId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

export const CodexCollabAgentEntry = memo(function CodexCollabAgentEntry({
  item,
  startedAtMs,
  endedAtMs,
}: {
  item: CodexCollabAgentToolCallItem;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
}) {
  const { t } = useI18n();
  const status = item.status ?? "inProgress";
  const running = status === "inProgress";
  const failed = status === "failed";
  const agents = Object.entries(item.agentsStates ?? {});
  const receivers = item.receiverThreadIds ?? [];
  const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
  // 目标数优先取 agentsStates（完成帧才有状态），退回 receiverThreadIds
  const targetCount = agents.length > 0 ? agents.length : receivers.length;
  const hasBody = Boolean(prompt) || agents.length > 0 || receivers.length > 0;
  const toolKey = COLLAB_TOOL_LABEL_KEY[item.tool as CodexCollabTool];
  const actionLabel = toolKey ? t(toolKey) : item.tool;

  const duration = formatDuration(
    typeof startedAtMs === "number" && typeof endedAtMs === "number"
      ? endedAtMs - startedAtMs
      : null,
  );

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<Users size={11} />}
      category={t("codex.tool.category.collab")}
      text={actionLabel}
      status={running ? "running" : failed ? "failed" : "ok"}
      failureDetail={
        failed
          ? agents
              .map(([id, state]) => (state.message ? `${shortThreadId(id)}: ${state.message}` : ""))
              .filter(Boolean)
              .join("\n") || status
          : null
      }
      collapsible={hasBody}
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
      meta={
        // 目标数 + 耗时并存：wait 常常跑几分钟（截图里的 186 秒就是等待），
        // 只给目标数会让用户完全看不出这一条已经等了多久。
        <>
          {targetCount > 0 && (
            <span style={s.codexToolMeta}>
              {t("codex.collab.targets", { count: targetCount })}
            </span>
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
      {prompt && (
        <div style={s.codexEntrySection}>
          <div style={s.codexEntrySectionLabel}>{t("codex.collab.prompt")}</div>
          <pre style={s.codexEntryJsonPre}>{prompt}</pre>
        </div>
      )}
      {targetCount > 0 && (
        <div style={s.codexEntrySection}>
          <div style={s.codexEntrySectionLabel}>{t("codex.collab.agents")}</div>
          {agents.length > 0 ? (
            agents.map(([id, state]) => (
              <CollabAgentRow key={id} id={id} state={state} />
            ))
          ) : (
            receivers.map((id) => <CollabAgentRow key={id} id={id} state={null} />)
          )}
        </div>
      )}
    </CodexToolCard>
  );
});

/** 单个目标智能体：短 id + 状态词（带语义色）+ 可选消息。 */
function CollabAgentRow({ id, state }: { id: string; state: CodexAgentStateLike | null }) {
  const agentStatus = typeof state?.status === "string" ? state.status : null;
  const message = typeof state?.message === "string" ? state.message : "";
  return (
    <div className="codex-stream-collab-agent">
      <span className="codex-stream-collab-agent-id">{shortThreadId(id)}</span>
      {agentStatus && (
        <span className="codex-stream-collab-agent-status" data-tone={collabStatusTone(agentStatus)}>
          {agentStatus}
        </span>
      )}
      {message && <span className="codex-stream-collab-agent-message">{message}</span>}
    </div>
  );
}

/** 子智能体状态 → 卡片状态语义色（运行中 / 成功 / 失败三色足够）。 */
function collabStatusTone(status: string): "running" | "ok" | "failed" {
  if (status === "running" || status === "pendingInit") return "running";
  if (status === "errored" || status === "notFound") return "failed";
  return "ok";
}
