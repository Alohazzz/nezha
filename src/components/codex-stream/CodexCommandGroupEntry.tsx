import { memo } from "react";
import { SquareTerminal } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { CodexCommandGroupChild } from "./codexCommandSummary";
import { summarizeCommand } from "./codexCommandSummary";
import { CodexToolCard } from "./CodexToolCard";
import { CodexCommandEntry } from "./CodexCommandEntry";

// 连续命令聚合组（对标 ZCode executeGroup，issue 密集度改版）：
// 两行以上的连续 commandExecution 塌缩成一条「终端 · N 个命令」摘要行，是流视图
// 降密集的主要手段——不聚合时每条命令都独占一行，十几条命令就把整屏占满。
//
// 摘要行状态演进（与 ZCode execute-group 一致）：
// - 运行中：阶段词「正在执行」+ 当前（最后一条活跃）命令；不自动展开，否则多条
//   并发运行时输出又会全部弹开。
// - 完成：阶段词「N 个命令」，有失败时追加红色「N 个失败」。
// 状态词（完成 / 运行中）整组不渲染——类别词高亮与耗时已表达同样的信息。
//
// 组 identity 由调用方的 groupKey（锚定首条命令 id）提供：流式追加命令时组件
// 不重建，CodexToolCard 的展开态持久才有意义。
export const CodexCommandGroupEntry = memo(function CodexCommandGroupEntry({
  groupKey,
  commands,
}: {
  groupKey: string;
  commands: CodexCommandGroupChild[];
}) {
  const { t } = useI18n();

  const failedCount = commands.filter(
    (child) => child.entry.item.status === "failed" || child.entry.item.status === "declined",
  ).length;
  // ES2022 目标下没有 findLast：倒序手找最后一条运行中的命令
  let runningChild: CodexCommandGroupChild | undefined;
  for (let i = commands.length - 1; i >= 0; i -= 1) {
    const child = commands[i];
    if (child?.entry.item.status === "inProgress") {
      runningChild = child;
      break;
    }
  }
  const running = runningChild !== undefined;
  // 运行中优先展示真正在跑的那条；全部完成后退回最后一条的命令文本（ZCode 同款）。
  const shownChild = runningChild ?? commands[commands.length - 1];
  const shownCommand = shownChild ? summarizeCommand(shownChild.entry.item.command) : "";
  const status: "running" | "ok" | "failed" = running ? "running" : failedCount > 0 ? "failed" : "ok";

  return (
    <CodexToolCard
      entryId={groupKey}
      icon={<SquareTerminal size={11} />}
      category={t("codex.tool.category.terminal")}
      label={
        running
          ? t("codex.tool.group.running")
          : t("codex.tool.group.commands", { count: commands.length })
      }
      text={shownCommand}
      status={status}
      showStatus={false}
      meta={
        // 失败计数只在收起态有意义（展开后每条子行自己带红色 exit 码 / 状态词）。
        // 用 groupStatus 判断而非仅 failedCount，覆盖「失败但无 exit code」的场景。
        !running && status === "failed" ? (
          <span style={s.codexToolMetaFailed}>
            {t("codex.tool.group.failed", { count: failedCount })}
          </span>
        ) : undefined
      }
      // 组不自动展开：运行中只看当前命令，需要明细时手动展开（与 ZCode 一致）。
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
      // 展开后子行会逐条显示命令，摘要行不再重复最后一条
      hideTextWhenExpanded
    >
      <div style={s.codexCommandGroupBody}>
        {commands.map((child) => (
          <CodexCommandEntry
            key={child.entry.item.id}
            item={child.entry.item}
            revision={child.entry.revision}
            startedAtMs={child.entry.startedAtMs}
            endedAtMs={child.entry.endedAtMs}
            compact
            showStatus={false}
          />
        ))}
      </div>
    </CodexToolCard>
  );
});
