import { memo } from "react";
import { FileEdit } from "lucide-react";
import type { CodexFileChangeItem } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { CodexToolCard } from "./CodexToolCard";
import { CodexDiffView } from "./CodexDiffView";
import { CodexThoughtLine } from "./CodexThoughtLine";
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
//
// 结构化改版（与思考卡交互一致）：正文不再自动展开 / 完成自动收起——编辑期间
// diff 流式增长时，摘要行跑马灯跟播最新一行变更（+/- 前缀保留语义色由文本自
// 带），完整 diff 保留在手动展开区。

/** 取流式 diff 的最新一行变更（最后一个文件的最后一行，带 +/- 前缀）。 */
function resolveLatestDiffLine(files: CodexDiffFile[]): string {
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const hunks = files[i]?.hunks ?? [];
    for (let j = hunks.length - 1; j >= 0; j -= 1) {
      const rows = hunks[j]?.rows ?? [];
      for (let k = rows.length - 1; k >= 0; k -= 1) {
        const row = rows[k];
        if (row && row.type !== "meta") {
          const sign = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
          return `${sign}${row.content}`;
        }
      }
    }
  }
  return "";
}

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
  onOpenGitChanges,
}: {
  item: CodexFileChangeItem;
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
  // 流式中：摘要行跟播最新一行变更（跑马灯，与思考卡一致）
  const liveLine = running ? resolveLatestDiffLine(files) : "";
  const liveSlot = running ? (
    <CodexThoughtLine text={liveLine} live mono testId="codex-filechange-live-line" />
  ) : undefined;

  if (single) {
    // 单文件 = 一张卡：文件名 + 徽标 + 统计 + diff 内容
    return (
      <CodexToolCard
        entryId={item.id}
        icon={<FileEdit size={11} />}
        category={t("codex.tool.category.fileChange")}
        text={single.path}
        textSlot={liveSlot}
        status={status}
        autoExpandWhileRunning={false}
        autoCollapseOnDone={false}
        // 展开后 diff 已完整呈现，摘要行不再重复跟播（与思考卡一致）
        hideTextWhenExpanded
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
      textSlot={liveSlot}
      status={status}
      autoExpandWhileRunning={false}
      autoCollapseOnDone={false}
      // 展开后子卡会逐个显示文件，摘要行不再重复跟播
      hideTextWhenExpanded
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
            // 子卡不参与自动展开（避免整批子卡同时弹开），手动点开
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
