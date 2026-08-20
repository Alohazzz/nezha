import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode } from "lucide-react";
import s from "../../styles";
import type { DiffFile, DiffHunk, DiffRow, DiffViewMode } from "./types";
import { fileDir, fileName, statusStyle } from "./parse";
import { SplitRows, UnifiedRow, type RowCommentProps } from "./DiffRows";
import type { DiffCommentDraft, DiffReviewComment } from "./diffReview";
import { useI18n } from "../../i18n";

function diffStatusLabelKey(status: DiffFile["status"]): string {
  switch (status) {
    case "added":
      return "git.added";
    case "deleted":
      return "git.deleted";
    case "renamed":
      return "git.renamed";
    case "copied":
      return "git.copied";
    case "modified":
      return "git.fileModified";
  }
}

function HunkHeader({
  header,
  split,
  hunkIndex,
  flash,
}: {
  header: string;
  split: boolean;
  hunkIndex: number;
  flash: boolean;
}) {
  return (
    <div
      data-diff-hunk={hunkIndex}
      style={{
        ...s.diffHunkHeader,
        ...(flash ? s.diffHunkHeaderFlash : null),
        ...(split
          ? {}
          : {
              display: "grid",
              gridTemplateColumns: "56px 56px 24px minmax(0, 1fr)",
            }),
      }}
    >
      {split ? (
        <span style={s.diffHunkHeaderText}>{header}</span>
      ) : (
        <>
          <span />
          <span />
          <span />
          <span style={s.diffHunkHeaderText}>{header}</span>
        </>
      )}
    </div>
  );
}

// 单个 hunk 的懒渲染容器：默认不渲染内容（只占一个 placeholder 高度），
// 进入视口时再挂载真实 DOM；一旦渲染就保持挂载，避免滚动时反复卸载触发闪烁。
function LazyHunkBody({
  rows,
  split,
  initiallyVisible,
  ...commentProps
}: { rows: DiffRow[]; split: boolean; initiallyVisible: boolean } & RowCommentProps) {
  const [visible, setVisible] = useState(initiallyVisible);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (visible) return;
    const el = hostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // 为避免占位高度与实际高度差距过大引起滚动抖动，用行数 × 22px 作为最小高度。
  const placeholderHeight = Math.max(rows.length * 22, 22);

  return (
    <div ref={hostRef} style={{ minHeight: visible ? 0 : placeholderHeight }}>
      {visible ? (
        split ? (
          <SplitRows rows={rows} {...commentProps} />
        ) : (
          rows.map((row, rowIndex) => <UnifiedRow key={rowIndex} row={row} {...commentProps} />)
        )
      ) : (
        <div style={s.diffLazyPlaceholder}>…</div>
      )}
    </div>
  );
}

function DiffHunkView({
  hunk,
  split,
  initiallyVisible,
  hunkIndex,
  flash,
  ...commentProps
}: {
  hunk: DiffHunk;
  split: boolean;
  initiallyVisible: boolean;
  hunkIndex: number;
  flash: boolean;
} & RowCommentProps) {
  return (
    <div>
      <HunkHeader header={hunk.header} split={split} hunkIndex={hunkIndex} flash={flash} />
      <LazyHunkBody
        rows={hunk.rows}
        split={split}
        initiallyVisible={initiallyVisible}
        {...commentProps}
      />
    </div>
  );
}

interface JumpRequest {
  comment: DiffReviewComment;
  seq: number;
}

export function DiffFileBlock({
  file,
  viewMode,
  diffKey,
  allowMentions,
  onCreateComment,
  jumpRequest,
  onJumpHandled,
}: {
  file: DiffFile;
  viewMode: DiffViewMode;
  diffKey: string;
  allowMentions: boolean;
  onCreateComment: (draft: DiffCommentDraft) => void;
  jumpRequest: JumpRequest | null;
  onJumpHandled: () => void;
}) {
  const { t } = useI18n();
  const dir = fileDir(file.displayPath);
  const name = fileName(file.displayPath);
  const isSplit = viewMode === "split";
  const status = statusStyle(file.status);
  const [collapsed, setCollapsed] = useState(false);
  const [flashHunk, setFlashHunk] = useState<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 抽屉跳转：展开文件块 → 滚动到目标行（行未挂载时回退到所在 hunk 头）→ 高亮 hunk。
  useEffect(() => {
    if (!jumpRequest || jumpRequest.comment.path !== file.displayPath) return;
    const line = jumpRequest.comment.startLine;
    const hunkIndex = file.hunks.findIndex((hunk) =>
      hunk.rows.some((row) => row.oldLine === line || row.newLine === line),
    );
    onJumpHandled();
    if (hunkIndex === -1) return;
    setCollapsed(false);
    setFlashHunk(hunkIndex);
    if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => setFlashHunk(null), 1600);
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const rowEl = root.querySelector(
        `[data-diff-line="${CSS.escape(`${file.displayPath}:${line}`)}"]`,
      );
      const hunkEl = root.querySelector(`[data-diff-hunk="${hunkIndex}"]`);
      (rowEl ?? hunkEl)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [jumpRequest, file.displayPath, file.hunks, onJumpHandled]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) window.clearTimeout(flashTimerRef.current);
    },
    [],
  );

  const commentProps: RowCommentProps = {
    displayPath: file.displayPath,
    diffKey,
    allowMentions,
    onCreateComment,
  };

  return (
    <div ref={rootRef} style={s.diffFileBlock}>
      <button
        type="button"
        style={s.diffFileHeader}
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("git.expandFile") : t("git.collapseFile")}
      >
        {collapsed ? (
          <ChevronRight size={14} color="var(--text-hint)" />
        ) : (
          <ChevronDown size={14} color="var(--text-hint)" />
        )}
        <FileCode size={14} color="var(--text-muted)" />
        <span style={s.diffFileName}>{name}</span>
        {dir && <span style={s.diffFileDir}>{dir}/</span>}
        {file.status === "renamed" && file.renameFrom && (
          <span style={{ ...s.diffFileDir, fontStyle: "italic" as const }}>
            ← {file.renameFrom}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!file.isBinary && (
          <>
            <span style={{ fontSize: 12, ...s.diffAddCount }}>+{file.additions}</span>
            <span style={{ fontSize: 12, ...s.diffDeleteCount }}>-{file.deletions}</span>
          </>
        )}
        <span style={{ ...s.diffStatusBadge, color: status.fg, background: status.bg }}>
          {t(diffStatusLabelKey(file.status))}
        </span>
      </button>

      {!collapsed && (
        <div style={s.diffFileBody}>
          {file.isBinary ? (
            <div style={s.diffFileEmpty}>{t("git.binaryFileNotShown")}</div>
          ) : file.hunks.length === 0 ? (
            <div style={s.diffFileEmpty}>
              {file.headerLines.length > 0
                ? file.headerLines.join("\n")
                : t("git.noTextualChanges")}
            </div>
          ) : (
            file.hunks.map((hunk, index) => (
              <DiffHunkView
                key={`${hunk.header}-${index}`}
                hunk={hunk}
                split={isSplit}
                initiallyVisible={index < 2}
                hunkIndex={index}
                flash={flashHunk === index}
                {...commentProps}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
