import type { ReactNode } from "react";
import type { CodexStreamEntry } from "../../hooks/codexStreamMerge";
import type {
  CodexAgentMessageItem,
  CodexCommandExecutionItem,
  CodexFileChangeItem,
  CodexItemFallback,
  CodexMcpToolCallItem,
  CodexPlanItem,
  CodexReasoningItem,
  CodexUserMessageItem,
} from "../../types";
import { CodexAgentMessageEntry } from "./CodexAgentMessageEntry";
import { CodexCommandEntry } from "./CodexCommandEntry";
import { CodexFallbackEntry } from "./CodexFallbackEntry";
import { CodexFileChangeEntry } from "./CodexFileChangeEntry";
import { CodexMcpToolCallEntry } from "./CodexMcpToolCallEntry";
import { CodexPlanEntry } from "./CodexPlanEntry";
import { CodexReasoningEntry } from "./CodexReasoningEntry";
import { CodexUserMessageEntry } from "./CodexUserMessageEntry";

// ── renderer 注册表（issue #117 T3，对标 ZCode resolveRenderer）──────────────
// 条目类型 → 渲染组件的查表分发，替代视图层 switch 硬编码。
// 新增上游条目类型 = 新增一个 renderer 文件 + 在这里加一行注册；
// 视图层（CodexStreamView）与本表之外零改动。
//
// kind ↔ item 精确类型的对应关系只在本表收口（每行一个 cast）；renderer 文件
// 本身持有各自的精确 item 类型。全部 renderer 经 memo 依赖 entry/item 引用
// （T1 保证 delta 产生新引用），无自定义比较器。

/** 单个 renderer 的统一入参：整个 entry 下传（含 revision）。 */
type EntryProps = { entry: CodexStreamEntry };

type EntryRenderer = (props: EntryProps) => ReactNode;

export const codexEntryRenderers: Record<CodexStreamEntry["kind"], EntryRenderer> = {
  userMessage: ({ entry }) => <CodexUserMessageEntry item={entry.item as CodexUserMessageItem} />,
  agentMessage: ({ entry }) => <CodexAgentMessageEntry item={entry.item as CodexAgentMessageItem} />,
  plan: ({ entry }) => <CodexPlanEntry item={entry.item as CodexPlanItem} />,
  reasoning: ({ entry }) => <CodexReasoningEntry item={entry.item as CodexReasoningItem} revision={entry.revision} />,
  commandExecution: ({ entry }) => (
    <CodexCommandEntry item={entry.item as CodexCommandExecutionItem} revision={entry.revision} />
  ),
  fileChange: ({ entry }) => <CodexFileChangeEntry item={entry.item as CodexFileChangeItem} revision={entry.revision} />,
  mcpToolCall: ({ entry }) => <CodexMcpToolCallEntry item={entry.item as CodexMcpToolCallItem} revision={entry.revision} />,
  fallback: ({ entry }) => <CodexFallbackEntry item={entry.item as CodexItemFallback} />,
};
