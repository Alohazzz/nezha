import { memo } from "react";
import { FileEdit } from "lucide-react";
import type { CodexFileChangeItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexDiffView } from "./CodexDiffView";
import {
  parseCodexFileDiff,
  parseCodexDiffText,
  summarizeCodexDiffFiles,
  type CodexDiffChangeKind,
  type CodexDiffFile,
} from "./codexDiffParse";

// 文件变更卡（issue #117 T4 重构）：
// - 单文件 = 一张卡：文件名 chip + 变更徽标 + +N/−N + diff 内容（两段式高亮）。
// - 多文件 = 父卡汇总（N files / 总 +N−−N）+ per-file 子卡独立展开。
//   子卡 entryId 用 `${条目id}:${下标}:${路径}` —— 模块级展开 Map 的键必须互不碰撞。
// - 解析宽容：diff 文本被截断 / 坏行也返回部分结果（codexDiffParse 保证不抛）。

function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span style={s.codexDiffStats}>
      <span style={s.codexDiffStatAdd}>+{additions}</span>
      <span style={s.codexDiffStatDel}>−{deletions}</span>
    </span>
  );
}

function DiffKindBadge({ kind }: { kind: CodexDiffChangeKind }) {
  return (
    <span className="codex-stream-diff-badge" data-kind={kind} style={s.codexDiffBadge}>
      {kind}
    </span>
  );
}

/** 文件头行：文件名 + rename 提示 + 徽标 + 统计。 */
function FileHead({ file }: { file: CodexDiffFile }) {
  const renamed = file.changeKind === "renamed" && file.oldPath && file.oldPath !== file.newPath;
  return (
    <div style={s.codexDiffFileHead}>
      <span style={s.codexDiffFileName}>{file.path}</span>
      {renamed && (
        <span style={s.codexDiffRenamePath}>
          ← {file.oldPath}
        </span>
      )}
      <DiffKindBadge kind={file.changeKind} />
      <DiffStats additions={file.additions} deletions={file.deletions} />
    </div>
  );
}

/** 展开区：文件头 + diff 视图（截断时带 GitChanges 跳转 footer）。 */
function FileDiffBody({
  file,
  onOpenGitChanges,
}: {
  file: CodexDiffFile;
  onOpenGitChanges?: () => void;
}) {
  return (
    <div>
      <FileHead file={file} />
      <div style={s.codexDiffPre}>
        <CodexDiffView file={file} onOpenFullDiff={onOpenGitChanges} />
      </div>
    </div>
  );
}

export const CodexFileChangeEntry = memo(function CodexFileChangeEntry({
  item,
  revision,
  onOpenGitChanges,
}: {
  item: CodexFileChangeItem;
  revision?: number;
  /** 截断 footer 的跳转入口（ProjectPage 的 openRightPanel("git-changes")）。 */
  onOpenGitChanges?: () => void;
}) {
  const { t } = useI18n();
  const running = item.status === "inProgress";
  const failed = item.status === "failed" || item.status === "declined";
  const status: "running" | "ok" | "failed" = running ? "running" : failed ? "failed" : "ok";

  // 结构化形态（上游权威）：path + kind 直接来自条目；diff 文本解析 hunk。
  // 整条目纯文本兜底：上游某天改成单帧 raw diff 时仍然可用；流式累积期
  // （fileChangeDelta 占位 change 的 path 未知为空）也走纯文本解析拼接形态。
  const structured =
    item.changes.length > 0 &&
    item.changes.every((c) => typeof c?.diff === "string" && c.path !== "");
  const files: CodexDiffFile[] = structured
    ? item.changes.map((change) => parseCodexFileDiff(change))
    : parseCodexDiffText(item.changes.map((c) => c?.diff ?? "").join("\n"));
  const totals = summarizeCodexDiffFiles(files);
  const single = files.length === 1 ? files[0] : null;

  if (single) {
    // 单文件 = 一张卡：文件名 + 徽标 + 统计 + diff 内容
    return (
      <CodexToolCard
        entryId={item.id}
        icon={<FileEdit size={11} />}
        category={t("codex.tool.category.fileChange")}
        text={single.path}
        status={status}
        autoExpandWhileRunning
        autoCollapseOnDone
        // 编辑期间 diff 流式增长（fileChangeDelta 递增 revision）→ 自动展开，
        // 编辑中实时可见（参照 ZCode）；完成边沿由 autoCollapseOnDone 收起。
        streamingRevision={revision}
        meta={<DiffStats additions={totals.additions} deletions={totals.deletions} />}
      >
        <FileDiffBody file={single} onOpenGitChanges={onOpenGitChanges} />
        {failed && <div style={s.codexEntryBodyFailed}>{item.status}</div>}
      </CodexToolCard>
    );
  }

  // 多文件 = 父卡汇总 + per-file 子卡独立展开（子卡键互不碰撞）
  return (
    <CodexToolCard
      entryId={item.id}
      icon={<FileEdit size={11} />}
      category={t("codex.tool.category.fileChange")}
      text={t("codex.fileChange.summary", { count: files.length })}
      status={status}
      autoExpandWhileRunning
      autoCollapseOnDone
      // 流式累积期（fileChangeDelta）父卡自动展开：文件段随 diff 文本增长逐个出现
      streamingRevision={revision}
      meta={<DiffStats additions={totals.additions} deletions={totals.deletions} />}
    >
      {files.map((file, i) => (
        <div key={`${i}:${file.path}`} style={s.codexDiffChildWrap}>
          <CodexToolCard
            entryId={`${item.id}:${i}:${file.path}`}
            icon={<FileEdit size={11} />}
            category={file.changeKind}
            text={file.path}
            status={status}
            // 子卡不参与骨架的运行中自动展开（避免整批子卡同时弹开），手动点开
            autoExpandWhileRunning={false}
            autoCollapseOnDone={false}
            meta={<DiffStats additions={file.additions} deletions={file.deletions} />}
          >
            <FileDiffBody file={file} onOpenGitChanges={onOpenGitChanges} />
          </CodexToolCard>
        </div>
      ))}
      {failed && <div style={s.codexEntryBodyFailed}>{item.status}</div>}
    </CodexToolCard>
  );
});
