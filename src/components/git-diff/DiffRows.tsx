import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Plus } from "lucide-react";
import s from "../../styles";
import { useI18n } from "../../i18n";
import { CommentComposer } from "../file-viewer/CommentComposer";
import type { DiffRow } from "./types";
import { lineMarker, rowTone } from "./parse";
import { isAnchorableRow, type DiffCommentDraft } from "./diffReview";

const UNIFIED_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "56px 56px 24px minmax(0, 1fr)",
  minHeight: 22,
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: "22px",
};

const SPLIT_CELL_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "48px 22px minmax(0, 1fr)",
  minHeight: 22,
  fontFamily: "var(--font-mono)",
  fontSize: 12.5,
  lineHeight: "22px",
  // 裁剪超长行，避免 whiteSpace:pre 的内容溢出本栏、越过中间分隔线串到另一栏
  overflow: "hidden",
};

const SPLIT_PAIR_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 1px minmax(0, 1fr)",
};

/** 评论按钮 + 输入卡片的公共状态逻辑（单行评论，决策 4/5） */
function useRowCommenter(
  row: DiffRow | undefined,
  commentProps: RowCommentProps,
): {
  line: number | undefined;
  commentable: boolean;
  button: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  composer: ReactNode;
} {
  const [composer, setComposer] = useState<{ x: number; y: number } | null>(null);
  // add/context → newLine；remove → oldLine（决策 2/4 锚定规则）
  const line = row ? (row.type === "remove" ? row.oldLine : row.newLine) : undefined;
  const commentable = line != null;

  const button = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!row) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setComposer({ x: rect.left, y: rect.bottom + 4 });
  };

  const submit = (text: string) => {
    if (!row || line == null) return;
    commentProps.onCreateComment({
      path: commentProps.displayPath,
      line,
      snippet: row.content,
      text,
      anchorable: isAnchorableRow(row.type, commentProps.allowMentions),
      diffKey: commentProps.diffKey,
    });
    setComposer(null);
  };

  const composerNode =
    composer && row && line != null ? (
      <CommentComposer
        location={`${commentProps.displayPath}:${line}`}
        snippet={row.content}
        x={composer.x}
        y={composer.y}
        onSubmit={submit}
        onCancel={() => setComposer(null)}
      />
    ) : null;

  return {
    line,
    commentable,
    button,
    composer: composerNode,
  };
}

export interface RowCommentProps {
  displayPath: string;
  diffKey: string;
  allowMentions: boolean;
  onCreateComment: (draft: DiffCommentDraft) => void;
}

function CommentPlusButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      style={visible ? { ...s.diffCommentBtn, ...s.diffCommentBtnVisible } : s.diffCommentBtn}
      onClick={onClick}
      title={t("reviewComments.add")}
      aria-label={t("reviewComments.add")}
    >
      <Plus size={12} />
    </button>
  );
}

export function UnifiedRow({ row, ...commentProps }: { row: DiffRow } & RowCommentProps) {
  const [hovered, setHovered] = useState(false);
  const { line, commentable, button, composer } = useRowCommenter(row, commentProps);
  const tone = rowTone(row.type);
  return (
    <div
      style={{ ...UNIFIED_GRID, background: tone.bg, position: "relative" }}
      data-diff-line={line != null ? `${commentProps.displayPath}:${line}` : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={s.diffLineNumber}>{row.oldLine ?? ""}</span>
      <span style={s.diffLineNumber}>{row.newLine ?? ""}</span>
      <span style={{ ...s.diffLineMarker, color: tone.fg, background: tone.markerBg }}>
        {lineMarker(row.type)}
      </span>
      <span style={{ ...s.diffLineContent, color: tone.fg }}>{row.content || " "}</span>
      {commentable && <CommentPlusButton visible={hovered} onClick={button} />}
      {composer}
    </div>
  );
}

function SplitCell({
  row,
  side,
  ...commentProps
}: { row?: DiffRow; side: "old" | "new" } & RowCommentProps) {
  const [hovered, setHovered] = useState(false);
  const { line, commentable, button, composer } = useRowCommenter(row, commentProps);

  if (!row) {
    return <div style={{ ...SPLIT_CELL_GRID, ...s.diffSplitEmpty }} />;
  }

  const tone = rowTone(row.type);
  const lineNumber = side === "old" ? row.oldLine : row.newLine;
  // context 行两侧都渲染同一行，只在 new 侧给出评论入口，避免重复
  const showButton = commentable && !(row.type === "context" && side === "old");

  return (
    <div
      style={{ ...SPLIT_CELL_GRID, background: tone.bg, position: "relative" }}
      data-diff-line={line != null ? `${commentProps.displayPath}:${line}` : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={s.diffLineNumber}>{lineNumber ?? ""}</span>
      <span style={{ ...s.diffLineMarker, color: tone.fg, background: tone.markerBg }}>
        {lineMarker(row.type)}
      </span>
      <span style={{ ...s.diffLineContent, color: tone.fg }}>{row.content || " "}</span>
      {showButton && <CommentPlusButton visible={hovered} onClick={button} />}
      {composer}
    </div>
  );
}

function SplitPair({ children }: { children: ReactNode }) {
  return <div style={SPLIT_PAIR_GRID}>{children}</div>;
}

const SPLIT_DIVIDER = <div style={{ background: "var(--border-dim)" }} aria-hidden />;

export function SplitRows({ rows, ...commentProps }: { rows: DiffRow[] } & RowCommentProps) {
  const rendered: ReactNode[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (row.type === "remove") {
      const removed: DiffRow[] = [];
      const added: DiffRow[] = [];
      while (rows[index]?.type === "remove") {
        removed.push(rows[index]);
        index += 1;
      }
      while (rows[index]?.type === "add") {
        added.push(rows[index]);
        index += 1;
      }
      index -= 1;
      const pairCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        rendered.push(
          <SplitPair key={`pair-${index}-${pairIndex}`}>
            <SplitCell row={removed[pairIndex]} side="old" {...commentProps} />
            {SPLIT_DIVIDER}
            <SplitCell row={added[pairIndex]} side="new" {...commentProps} />
          </SplitPair>,
        );
      }
      continue;
    }

    if (row.type === "add") {
      rendered.push(
        <SplitPair key={`add-${index}`}>
          <SplitCell side="old" {...commentProps} />
          {SPLIT_DIVIDER}
          <SplitCell row={row} side="new" {...commentProps} />
        </SplitPair>,
      );
      continue;
    }

    if (row.type === "meta") {
      rendered.push(
        <div key={`meta-${index}`} style={s.diffMetaRow}>
          {row.content}
        </div>,
      );
      continue;
    }

    rendered.push(
      <SplitPair key={`context-${index}`}>
        <SplitCell row={row} side="old" {...commentProps} />
        {SPLIT_DIVIDER}
        <SplitCell row={row} side="new" {...commentProps} />
      </SplitPair>,
    );
  }

  return <>{rendered}</>;
}
