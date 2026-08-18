import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactCodeMirror, { EditorView } from "@uiw/react-codemirror";
import type { Extension } from "@codemirror/state";
import { Plus } from "lucide-react";
import s from "../../styles";
import { useI18n } from "../../i18n";
import { CommentComposer } from "./CommentComposer";
import {
  toRelativeProjectPath,
  truncateSnippet,
  type CommentDraft,
} from "./reviewComments";

type ComposerSource = "bubble" | "line" | "menu";

interface AnchorState {
  startLine: number;
  endLine: number;
  snippet: string;
}

interface BubbleState extends AnchorState {
  x: number;
  y: number;
}

/**
 * 可评论的代码编辑器：在 ReactCodeMirror 之上叠加「选中浮气泡 / gutter 单击 /
 * 右键菜单」三个创建入口，并处理评论列表的跳转定位。纯展示层——评论数据与
 * 发送逻辑都在上层（ProjectPage），这里只上报 CommentDraft。
 */
export function CommentableEditor({
  value,
  onChange,
  theme,
  baseExtensions,
  filePath,
  projectPath,
  onCreateComment,
  jumpRequest,
  onJumpHandled,
}: {
  value: string;
  onChange: (value: string) => void;
  theme: Extension;
  baseExtensions: Extension[];
  filePath: string;
  projectPath: string;
  onCreateComment: (draft: CommentDraft) => void;
  jumpRequest: { line: number; seq: number } | null;
  onJumpHandled: () => void;
}) {
  const { t } = useI18n();
  const viewRef = useRef<EditorView | null>(null);
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [ctxMenu, setCtxMenu] = useState<BubbleState | null>(null);
  const [composer, setComposer] = useState<(BubbleState & { source: ComposerSource }) | null>(
    null,
  );

  // 跳转请求可能先于编辑器挂载到达（切 tab 场景），先用 ref 存住，onCreateEditor 时补发。
  const pendingJumpRef = useRef<{ line: number; seq: number } | null>(null);

  const applyJump = useCallback(
    (view: EditorView, line: number) => {
      const doc = view.state.doc;
      const clamped = Math.max(1, Math.min(line, doc.lines));
      const lineInfo = doc.line(clamped);
      view.dispatch({
        selection: { anchor: lineInfo.from, head: lineInfo.to },
        effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
      });
      view.focus();
    },
    [],
  );

  useEffect(() => {
    pendingJumpRef.current = jumpRequest;
    if (!jumpRequest) return;
    const view = viewRef.current;
    if (!view) return;
    applyJump(view, jumpRequest.line);
    onJumpHandled();
  }, [jumpRequest, applyJump, onJumpHandled]);

  // 右键菜单：点击菜单外部任意处关闭。
  useEffect(() => {
    if (!ctxMenu) return;
    const dismiss = (event: Event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-rc-ctx-menu]")) return;
      setCtxMenu(null);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [ctxMenu]);

  const relativePath = useMemo(
    () => toRelativeProjectPath(projectPath, filePath),
    [projectPath, filePath],
  );

  const locationLabel = useMemo(() => {
    if (!composer) return "";
    return `${relativePath}:${composer.startLine}${
      composer.endLine !== composer.startLine ? `-${composer.endLine}` : ""
    }`;
  }, [composer, relativePath]);

  const handleSubmit = useCallback(
    (text: string) => {
      if (!composer) return;
      onCreateComment({
        path: relativePath,
        startLine: composer.startLine,
        endLine: composer.endLine,
        snippet: truncateSnippet(composer.snippet),
        text,
      });
      setComposer(null);
    },
    [composer, onCreateComment, relativePath],
  );

  const editorExtensions = useMemo(() => {
    const selectionListener = EditorView.updateListener.of((update) => {
      if (!update.selectionSet && !update.docChanged) return;
      const view = update.view;
      const sel = view.state.selection.main;
      if (sel.empty) {
        setBubble(null);
        return;
      }
      const startLine = view.state.doc.lineAt(sel.from).number;
      const endLine = view.state.doc.lineAt(sel.to).number;
      const snippet = view.state.doc.sliceString(sel.from, sel.to);
      const coords = view.coordsAtPos(sel.to);
      if (!coords) {
        setBubble(null);
        return;
      }
      setBubble({ x: coords.left, y: coords.bottom + 6, startLine, endLine, snippet });
    });

    const domHandlers = EditorView.domEventHandlers({
      // gutter 单击 → 单行评论（不选中也能评论，决策 2 的 C）。
      // 折叠箭头所在 .cm-foldGutter 让行：不劫持，保留折叠交互。
      mousedown: (event: MouseEvent, view: EditorView) => {
        const target = event.target as HTMLElement;
        if (!target.closest(".cm-gutterElement")) return;
        if (target.closest(".cm-foldGutter")) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
          return;
        }
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return;
        const line = view.state.doc.lineAt(pos).number;
        event.preventDefault();
        setBubble(null);
        setComposer({
          x: event.clientX,
          y: event.clientY,
          startLine: line,
          endLine: line,
          snippet: view.state.doc.lineAt(pos).text,
          source: "line",
        });
      },
      // 有选区时右键 → 自定义菜单「添加评论」；无选区保留原生复制/粘贴菜单。
      contextmenu: (event: MouseEvent, view: EditorView) => {
        const target = event.target as HTMLElement;
        if (target.closest(".cm-gutter")) return;
        const sel = view.state.selection.main;
        if (sel.empty) return;
        event.preventDefault();
        const startLine = view.state.doc.lineAt(sel.from).number;
        const endLine = view.state.doc.lineAt(sel.to).number;
        const snippet = view.state.doc.sliceString(sel.from, sel.to);
        setCtxMenu({ x: event.clientX, y: event.clientY, startLine, endLine, snippet });
      },
    });

    return [...baseExtensions, selectionListener, domHandlers];
  }, [baseExtensions]);

  return (
    <>
      <ReactCodeMirror
        value={value}
        onChange={onChange}
        theme={theme}
        extensions={editorExtensions}
        height="100%"
        style={{ height: "100%" }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightSelectionMatches: true,
          autocompletion: false,
          searchKeymap: true,
        }}
        onCreateEditor={(view) => {
          viewRef.current = view;
          const pending = pendingJumpRef.current;
          if (pending) {
            applyJump(view, pending.line);
            pendingJumpRef.current = null;
            onJumpHandled();
          }
        }}
      />
      {bubble && !composer && (
        <button
          type="button"
          style={{ ...s.rcBubble, left: bubble.x, top: bubble.y }}
          title={t("reviewComments.add")}
          aria-label={t("reviewComments.add")}
          onClick={(event) => {
            event.stopPropagation();
            setComposer({ ...bubble, source: "bubble" });
          }}
        >
          <Plus size={14} />
        </button>
      )}
      {ctxMenu && (
        <div data-rc-ctx-menu style={{ ...s.rcCtxMenu, left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            type="button"
            style={s.rcCtxMenuItem}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "var(--accent)";
              event.currentTarget.style.color = "var(--fg-on-accent)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
              event.currentTarget.style.color = "var(--text-primary)";
            }}
            onClick={() => {
              setComposer({ ...ctxMenu, source: "menu" });
              setCtxMenu(null);
            }}
          >
            {t("reviewComments.add")}
          </button>
        </div>
      )}
      {composer && (
        <CommentComposer
          location={locationLabel}
          snippet={composer.snippet}
          x={composer.x}
          y={composer.y}
          onSubmit={handleSubmit}
          onCancel={() => setComposer(null)}
        />
      )}
    </>
  );
}
