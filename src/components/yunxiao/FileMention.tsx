import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, KeyboardEvent, RefObject, SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MentionPopover, type FileEntry } from "../new-task/MentionPopover";
import s from "../../styles";

/**
 * 云效补充表单的 @ 文件引用字段（纯文本插入）。
 *
 * 触发规则与新建任务视图一致：光标前最后一个 `@` 开始，query 不含空格/换行；
 * 选中后把 `@query` 替换为 `@相对路径`（`list_project_files` 返回相对路径）。
 * 文件列表按项目路径懒加载并缓存；过滤 200ms 防抖（AGENTS.md 万级文件约束）。
 * 浮层锚定字段（外层 relative），默认在字段上方，字段靠近视口顶部时翻转到下方。
 */

const FILE_CACHE = new Map<string, FileEntry[]>();
const INFLIGHT = new Map<string, Promise<FileEntry[]>>();

function parseFileEntry(f: string): FileEntry {
  const parts = f.split("/");
  const name = parts[parts.length - 1];
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return { name, path: f, dir, ext };
}

function loadProjectFiles(projectPath: string): Promise<FileEntry[]> {
  const cached = FILE_CACHE.get(projectPath);
  if (cached) return Promise.resolve(cached);
  const inflight = INFLIGHT.get(projectPath);
  if (inflight) return inflight;
  const promise = invoke<string[]>("list_project_files", { projectPath })
    .then((files) => {
      const parsed = files.map(parseFileEntry);
      FILE_CACHE.set(projectPath, parsed);
      INFLIGHT.delete(projectPath);
      return parsed;
    })
    .catch((e) => {
      INFLIGHT.delete(projectPath);
      throw e;
    });
  INFLIGHT.set(projectPath, promise);
  return promise;
}

interface MentionState {
  query: string;
  index: number;
  items: FileEntry[];
  loading: boolean;
}

function parseQuery(text: string, caret: number): { atIdx: number; query: string } | null {
  const textBefore = text.slice(0, caret);
  const atIdx = textBefore.lastIndexOf("@");
  if (atIdx === -1) return null;
  const query = textBefore.slice(atIdx + 1);
  if (query.includes(" ") || query.includes("\n")) return null;
  return { atIdx, query };
}

export function FileMentionField({
  as,
  value,
  onChange,
  placeholder,
  style,
  projectPath,
}: {
  as: "input" | "textarea";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: CSSProperties;
  projectPath: string;
}) {
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const caretRef = useRef(value.length);
  const isComposingRef = useRef(false);
  // 插入后 setSelectionRange 会触发 select 事件，避免浮层立刻重新弹出。
  const suppressMentionRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const placementRef = useRef<"above" | "below">("above");
  const [mention, setMention] = useState<MentionState | null>(null);
  const mentionRef = useRef(mention);

  valueRef.current = value;
  mentionRef.current = mention;

  const updateMention = useCallback(
    (query: string) => {
      const el = fieldRef.current;
      if (el) {
        placementRef.current = el.getBoundingClientRect().top < 280 ? "below" : "above";
      }
      setMention({ query, index: 0, items: [], loading: true });
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        loadProjectFiles(projectPath)
          .then((files) => {
            const q = query.trim().toLowerCase();
            const items = files
              .filter(
                (f) =>
                  !q || f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q),
              )
              .slice(0, 8);
            setMention((prev) =>
              prev && prev.query === query ? { ...prev, items, loading: false } : prev,
            );
          })
          .catch(() => {
            setMention((prev) =>
              prev && prev.query === query ? { ...prev, items: [], loading: false } : prev,
            );
          });
      }, 200);
    },
    [projectPath],
  );

  const dismissMention = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setMention(null);
  }, []);

  const syncFromField = useCallback(
    (el: HTMLInputElement | HTMLTextAreaElement, allowOpen: boolean) => {
      if (isComposingRef.current) return;
      if (suppressMentionRef.current) {
        suppressMentionRef.current = false;
        return;
      }
      caretRef.current = el.selectionStart ?? el.value.length;
      const info = parseQuery(el.value, caretRef.current);
      if (info && (allowOpen || mentionRef.current)) updateMention(info.query);
      else dismissMention();
    },
    [updateMention, dismissMention],
  );

  function handleChange(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    const el = e.target;
    const next = el.value;
    const caret = el.selectionStart ?? next.length;
    valueRef.current = next;
    caretRef.current = caret;
    suppressMentionRef.current = false;
    onChange(next);
    syncFromField(el, true);
  }

  function handleSelect(e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) {
    syncFromField(e.currentTarget, false);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (isComposingRef.current) return;
    if (mention && mention.items.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMention((m) =>
          m ? { ...m, index: Math.min(m.index + 1, m.items.length - 1) } : m,
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMention((m) => (m ? { ...m, index: Math.max(m.index - 1, 0) } : m));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = mention.items[mention.index];
        if (item) insertFile(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissMention();
        return;
      }
    }
  }

  function insertFile(file: FileEntry) {
    const text = valueRef.current;
    const caret = caretRef.current;
    const info = parseQuery(text, caret);
    if (!info) return;
    const inserted = `@${file.path}`;
    const next = text.slice(0, info.atIdx) + inserted + text.slice(caret);
    valueRef.current = next;
    caretRef.current = info.atIdx + inserted.length;
    suppressMentionRef.current = true;
    dismissMention();
    onChange(next);
    requestAnimationFrame(() => {
      const node = fieldRef.current;
      if (node && caretRef.current !== null) {
        const pos = Math.min(caretRef.current, node.value.length);
        node.setSelectionRange(pos, pos);
        node.focus();
      }
    });
  }

  const fieldProps = {
    style,
    value,
    placeholder,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onSelect: handleSelect,
    onBlur: dismissMention,
    onCompositionStart: () => {
      isComposingRef.current = true;
    },
    onCompositionEnd: (e: SyntheticEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      isComposingRef.current = false;
      syncFromField(e.currentTarget, true);
    },
  };

  return (
    <div style={s.yunxiaoMentionAnchor}>
      {as === "input" ? (
        <input
          {...fieldProps}
          ref={fieldRef as RefObject<HTMLInputElement>}
        />
      ) : (
        <textarea
          {...fieldProps}
          ref={fieldRef as RefObject<HTMLTextAreaElement>}
        />
      )}
      {mention && (
        <MentionPopover
          mentionSearch={mention.query}
          mentionItems={mention.items.map((f) => ({ kind: "file", file: f }))}
          mentionIndex={mention.index}
          filesLoading={mention.loading}
          placement={placementRef.current}
          onSelectFile={(file) => insertFile(file)}
          onSetMentionIndex={(index) => setMention((m) => (m ? { ...m, index } : m))}
        />
      )}
    </div>
  );
}
