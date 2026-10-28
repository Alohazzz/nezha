import type { ReactNode } from "react";
import type { CodexStreamEntry } from "../../hooks/codexStreamMerge";
import type {
  CodexAgentMessageItem,
  CodexCollabAgentToolCallItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexImageViewItem,
  CodexItemFallback,
  CodexMcpToolCallItem,
  CodexPlanItem,
  CodexReasoningItem,
  CodexSubAgentActivityItem,
  CodexUserMessageItem,
} from "../../types";
import { CodexAgentMessageEntry } from "./CodexAgentMessageEntry";
import { CodexCollabAgentEntry } from "./CodexCollabAgentEntry";
import { CodexCommandEntry } from "./CodexCommandEntry";
import { CodexFallbackEntry } from "./CodexFallbackEntry";
import { CodexFileChangeEntry } from "./CodexFileChangeEntry";
import { CodexImageViewEntry } from "./CodexImageViewEntry";
import { CodexMcpToolCallEntry } from "./CodexMcpToolCallEntry";
import { CodexPlanEntry } from "./CodexPlanEntry";
import { CodexReasoningEntry } from "./CodexReasoningEntry";
import { CodexSubAgentEntry } from "./CodexSubAgentEntry";
import { CodexUserMessageEntry } from "./CodexUserMessageEntry";

// ── renderer 注册表（issue #117 T3，对标 ZCode resolveRenderer）──────────────
// 条目类型 → 渲染组件的查表分发，替代视图层 switch 硬编码。
// 新增上游条目类型 = 新增一个 renderer 文件 + 在这里加一行注册；
// 视图层（CodexStreamView）与本表之外零改动。
//
// kind ↔ item 精确类型的对应关系只在本表收口（每行一个 cast）；renderer 文件
// 本身持有各自的精确 item 类型。全部 renderer 经 memo 依赖 entry/item 引用
// （T1 保证 delta 产生新引用），无自定义比较器。

/** 单个 renderer 的统一入参：整个 entry 下传（含 revision）。
 * onOpenGitChanges：截断 diff 的跳转入口（GitChanges 右面板），仅 fileChange 用。
 * entryIndex：视图层位置序号，仅 fallback 用（无 id 条目的展开键消歧）。 */
type EntryProps = { entry: CodexStreamEntry; onOpenGitChanges?: () => void; entryIndex?: number };

type EntryRenderer = (props: EntryProps) => ReactNode;

export const codexEntryRenderers: Record<CodexStreamEntry["kind"], EntryRenderer> = {
  userMessage: ({ entry }) => <CodexUserMessageEntry item={entry.item as CodexUserMessageItem} />,
  agentMessage: ({ entry }) => <CodexAgentMessageEntry item={entry.item as CodexAgentMessageItem} />,
  plan: ({ entry }) => <CodexPlanEntry item={entry.item as CodexPlanItem} />,
  imageView: ({ entry }) => <CodexImageViewEntry item={entry.item as CodexImageViewItem} />,
  reasoning: ({ entry }) => (
    <CodexReasoningEntry
      item={entry.item as CodexReasoningItem}
      revision={entry.revision}
      startedAtMs={entry.startedAtMs}
      endedAtMs={entry.endedAtMs}
    />
  ),
  commandExecution: ({ entry }) => (
    <CodexCommandEntry
      item={entry.item as CodexCommandExecutionItem}
      revision={entry.revision}
      startedAtMs={entry.startedAtMs}
      endedAtMs={entry.endedAtMs}
    />
  ),
  fileChange: ({ entry, onOpenGitChanges }) => (
    <CodexFileChangeEntry
      item={entry.item as CodexFileChangeItem}
      revision={entry.revision}
      onOpenGitChanges={onOpenGitChanges}
    />
  ),
  mcpToolCall: ({ entry }) => <CodexMcpToolCallEntry item={entry.item as CodexMcpToolCallItem} revision={entry.revision} />,
  collabAgentToolCall: ({ entry }) => (
    <CodexCollabAgentEntry
      item={entry.item as CodexCollabAgentToolCallItem}
      startedAtMs={entry.startedAtMs}
      endedAtMs={entry.endedAtMs}
    />
  ),
  subAgentActivity: ({ entry }) => (
    <CodexSubAgentEntry
      item={entry.item as CodexSubAgentActivityItem}
      startedAtMs={entry.startedAtMs}
      endedAtMs={entry.endedAtMs}
    />
  ),
  fallback: ({ entry, entryIndex }) => (
    <CodexFallbackEntry item={entry.item as CodexItemFallback} entryIndex={entryIndex} />
  ),
};

/** 单条条目渲染入口：查表 + 分发。
 *
 * 轮次分段（codexTurnSegments → CodexTurnSection）与流视图顶层共用同一入口，
 * 避免两处各写一遍 key / 索引逻辑；注册表仍是唯一分发点。 */
export function CodexEntry(props: EntryProps) {
  const render = codexEntryRenderers[props.entry.kind];
  return <>{render(props)}</>;
}
