import { memo } from "react";
import { FileEdit } from "lucide-react";
import type { CodexFileChangeItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";

// 文件变更卡（issue #117 T3 自 CodexEntryItems 迁出）：骨架管折叠行为——
// 默认收起、运行中自动展开、完成自动收起（此前永远摊开不可收）。
// 摘要行：文件数 + 状态；展开区为逐文件 unified diff 纯文本 +/- 染色，
// hunk 解析 / 高亮 / 统计是 T4 的事，本卡保持现状渲染。

export const CodexFileChangeEntry = memo(function CodexFileChangeEntry({
  item,
}: {
  item: CodexFileChangeItem;
  revision?: number;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || item.status === "declined";
  const status: "running" | "ok" | "failed" = running ? "running" : failed ? "failed" : "ok";
  const fileCount = item.changes.length;
  // 单文件直出路径；多文件父卡汇总（spec：多文件拆 per-file 子卡是 T4）
  const text =
    fileCount === 1 && item.changes[0]
      ? item.changes[0].path
      : t("codex.fileChange.summary", { count: fileCount });

  return (
    <CodexToolCard
      entryId={item.id}
      icon={<FileEdit size={11} />}
      category="File change"
      text={text}
      status={status}
      autoExpandWhileRunning
      autoCollapseOnDone
      meta={
        fileCount > 1 ? <span style={s.codexToolMeta}>{fileCount}</span> : null
      }
    >
      {item.changes.map((change) => (
        <div key={change.path}>
          <div style={s.codexDiffFileHeader}>
            <span>{change.path}</span>
            {change.kind.type === "update" && change.kind.movePath && (
              <span style={s.codexDiffMovePath}>→ {change.kind.movePath}</span>
            )}
            <span style={s.codexDiffKindBadge} data-kind={change.kind.type}>
              {change.kind.type}
            </span>
          </div>
          <pre style={s.codexDiffPre}>
            {change.diff.split("\n").map((line, i) => (
              <span key={i} style={diffLineStyle(line)}>
                {line || " "}
              </span>
            ))}
          </pre>
        </div>
      ))}
      {failed && <div style={s.codexEntryBodyFailed}>{item.status}</div>}
    </CodexToolCard>
  );
});

/** 按行首 +/- 染色（纯选择，不造 inline 对象；样式键在 codex-stream.ts）。 */
function diffLineStyle(line: string) {
  const isAdd = line.startsWith("+") && !line.startsWith("+++");
  const isDel = line.startsWith("-") && !line.startsWith("---");
  if (isAdd) return s.codexDiffLineAdd;
  if (isDel) return s.codexDiffLineDel;
  return s.codexDiffLine;
}
