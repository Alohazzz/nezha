import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Columns2, FileCode, Rows3, X } from "lucide-react";
import { DiffFileBlock } from "./git-diff/DiffFileBlock";
import { parseDiff } from "./git-diff/parse";
import type { DiffViewMode } from "./git-diff/types";
import { CommentDrawer } from "./file-viewer/CommentDrawer";
import {
  commentMatchesDiff,
  diffKeyString,
  type DiffCommentDraft,
  type DiffKey,
  type DiffReviewComment,
} from "./git-diff/diffReview";
import type { ReviewComment } from "./file-viewer/reviewComments";
import { load, save } from "../utils";
import { useI18n } from "../i18n";
import s from "../styles";

const VIEW_MODE_KEY = "nezha.diffViewMode";

interface Props {
  projectRoot: string;
  repoPath: string;
  // "commit" = full commit diff, "file" = working-tree file diff, "commit-file" = single file in a commit
  mode: "commit" | "file" | "commit-file";
  commitHash?: string;
  filePath?: string;
  staged?: boolean;
  title: string;
  onClose: () => void;
  comments: DiffReviewComment[];
  onCreateComment: (draft: DiffCommentDraft) => void;
  onUpdateCommentText: (id: string, text: string) => void;
  onDeleteComment: (id: string) => void;
  onToggleCommentStatus: (id: string) => void;
  onSendComments: (ids: string[]) => void;
}

function ViewToggleButton({
  active,
  title,
  onClick,
  children,
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={active ? s.diffToggleBtnActive : s.diffToggleBtnInactive}
    >
      {children}
    </button>
  );
}

export function GitDiffViewer({
  projectRoot,
  repoPath,
  mode,
  commitHash,
  filePath,
  staged,
  title,
  onClose,
  comments,
  onCreateComment,
  onUpdateCommentText,
  onDeleteComment,
  onToggleCommentStatus,
  onSendComments,
}: Props) {
  const { t } = useI18n();
  const [diff, setDiff] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<DiffViewMode>(() =>
    load<DiffViewMode>(VIEW_MODE_KEY, "unified"),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 抽屉跳转请求（seq 保证同一条目重复点击也触发）。
  const [jumpReq, setJumpReq] = useState<{ comment: DiffReviewComment; seq: number } | null>(null);

  useEffect(() => {
    save(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadDiff = async () => {
      try {
        let result: string;
        if (mode === "commit" && commitHash) {
          result = await invoke<string>("git_show_diff", {
            projectPath: projectRoot,
            repoPath,
            commitHash,
          });
        } else if (mode === "commit-file" && commitHash && filePath !== undefined) {
          result = await invoke<string>("git_show_file_diff", {
            projectPath: projectRoot,
            repoPath,
            commitHash,
            filePath,
          });
        } else if (mode === "file" && filePath !== undefined) {
          result = await invoke<string>("git_file_diff", {
            projectPath: projectRoot,
            repoPath,
            filePath,
            staged: staged ?? false,
          });
        } else {
          result = "";
        }
        if (!cancelled) setDiff(result);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadDiff();
    return () => {
      cancelled = true;
    };
  }, [projectRoot, repoPath, mode, commitHash, filePath, staged]);

  const { parsedFiles, totalAdditions, totalDeletions } = useMemo(() => {
    const files = parseDiff(diff, repoPath);
    let add = 0;
    let del = 0;
    for (const f of files) {
      add += f.additions;
      del += f.deletions;
    }
    return { parsedFiles: files, totalAdditions: add, totalDeletions: del };
  }, [diff, repoPath]);

  const diffKey: DiffKey = useMemo(() => {
    if (mode === "commit" && commitHash) return { kind: "commit", commitHash };
    if (mode === "commit-file" && commitHash && filePath !== undefined) {
      return { kind: "commit", commitHash, filePath };
    }
    if (mode === "file" && filePath !== undefined) {
      return { kind: "worktree", filePath, staged: staged ?? false };
    }
    return { kind: "worktree", filePath: "", staged: false };
  }, [mode, commitHash, filePath, staged]);

  // 只展示当前 diff 身份下的评论（整仓 commit diff 匹配该 commit 全部文件）。
  const visibleComments = useMemo(
    () => comments.filter((c) => commentMatchesDiff(c, diffKey)),
    [comments, diffKey],
  );

  // 仅工作区 diff 的行号对应当前文件，允许 @路径:行号 锚定。
  const allowMentions = mode === "file";

  const handleJumpHandled = useCallback(() => setJumpReq(null), []);
  const handleJumpToComment = useCallback((comment: ReviewComment) => {
    setJumpReq((prev) => ({ comment: comment as DiffReviewComment, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  return (
    <div style={s.diffViewer}>
      <div style={s.diffHeader}>
        <FileCode size={15} color="var(--text-muted)" />
        <div style={s.diffHeaderTitleWrap}>
          <div style={s.diffHeaderTitle}>{title}</div>
          <div style={s.diffHeaderMeta}>
            <span>
              {t(parsedFiles.length === 1 ? "common.fileChanged" : "common.filesChanged", {
                count: parsedFiles.length,
              })}
            </span>
            <span style={s.diffAddCount}>+{totalAdditions}</span>
            <span style={s.diffDeleteCount}>-{totalDeletions}</span>
          </div>
        </div>

        <div style={s.diffViewToggle} role="group" aria-label={t("git.diffViewMode")}>
          <ViewToggleButton
            active={viewMode === "unified"}
            title={t("git.singleColumnDiff")}
            onClick={() => setViewMode("unified")}
          >
            <Rows3 size={15} />
          </ViewToggleButton>
          <ViewToggleButton
            active={viewMode === "split"}
            title={t("git.twoColumnDiff")}
            onClick={() => setViewMode("split")}
          >
            <Columns2 size={15} />
          </ViewToggleButton>
        </div>

        <button
          type="button"
          onClick={onClose}
          title={t("git.closeDiff")}
          aria-label={t("git.closeDiff")}
          style={s.diffCloseBtn}
        >
          <X size={15} />
        </button>
      </div>

      <div style={s.diffContent}>
        {loading ? (
          <div style={s.diffStateMessage}>{t("git.loadingDiff")}</div>
        ) : error ? (
          <div style={s.diffStateError}>{error}</div>
        ) : diff.trim() === "" ? (
          <div style={s.diffStateMessage}>{t("git.noChanges")}</div>
        ) : (
          <div style={s.diffFileList}>
            {parsedFiles.map((file, index) => (
              <DiffFileBlock
                key={`${file.displayPath}-${index}`}
                file={file}
                viewMode={viewMode}
                diffKey={diffKeyString(diffKey)}
                allowMentions={allowMentions}
                onCreateComment={onCreateComment}
                jumpRequest={jumpReq}
                onJumpHandled={handleJumpHandled}
              />
            ))}
          </div>
        )}
      </div>

      {visibleComments.length > 0 && (
        <CommentDrawer
          comments={visibleComments}
          open={drawerOpen}
          onToggleOpen={() => setDrawerOpen((v) => !v)}
          onJump={handleJumpToComment}
          onUpdateText={onUpdateCommentText}
          onDelete={onDeleteComment}
          onToggleStatus={onToggleCommentStatus}
          onSend={onSendComments}
          emptyHint={t("reviewComments.emptyDiff")}
        />
      )}
    </div>
  );
}
