import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileCode2, FileText, Sparkles, SquareSlash } from "lucide-react";
import type { AgentCommand, Skill } from "../../types";
import { CODE_EXTS } from "../../utils";
import { useI18n } from "../../i18n";
import s from "../../styles";

/**
 * composer 快捷召唤（参照 ZCode 的 slash-command 形态），支持三种触发符：
 * - `$query` 技能：选中后展开为「请读取并遵循 xxx 技能：<SKILL.md 路径>」
 * - `/query` 命令：Agent 自定义命令（Claude commands / Codex prompts），
 *   展开为「请执行 xxx 命令：读取 <命令文件> 的内容并严格按其执行」
 * - `@query` 文件：项目文件引用，插入相对路径（agent 按路径读取）
 *
 * 本模块提供两块积木：
 * - `useComposerMention` —— 面向纯文本输入框（textarea/input）的触发检测 + 键盘导航 + 替换写入；
 * - `ComposerMentionPopover` —— 浮层渲染（宿主外层需要 position: relative）。
 *
 * contentEditable 编辑器（PromptEditor）目前只接了 `$` 技能（SkillMention 时代的
 * 遗留拆分）；textarea 侧以本模块为准。
 */

// ── 数据加载（模块级缓存，变更低频）─────────────────────────────────────────

let SKILL_CACHE: Skill[] | null = null;
const COMMAND_CACHE = new Map<string, AgentCommand[]>();

export function invalidateMentionCaches() {
  SKILL_CACHE = null;
  COMMAND_CACHE.clear();
}

export function loadSkills(): Promise<Skill[]> {
  if (SKILL_CACHE) return Promise.resolve(SKILL_CACHE);
  return invoke<Skill[]>("list_skills")
    .then((rows) => {
      SKILL_CACHE = rows ?? [];
      return SKILL_CACHE;
    })
    .catch((e) => {
      // 404（未配置技能库）等错误按空列表处理，不打扰输入体验
      console.warn("[composerMention] list_skills failed:", e);
      SKILL_CACHE = [];
      return SKILL_CACHE;
    });
}

export function loadAgentCommands(projectPath: string | null): Promise<AgentCommand[]> {
  const key = projectPath ?? "";
  const cached = COMMAND_CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  return invoke<AgentCommand[]>("list_agent_commands", { projectPath: projectPath ?? null })
    .then((rows) => {
      COMMAND_CACHE.set(key, rows ?? []);
      return rows ?? [];
    })
    .catch((e) => {
      console.warn("[composerMention] list_agent_commands failed:", e);
      COMMAND_CACHE.set(key, []);
      return [];
    });
}

const FILE_CACHE = new Map<string, string[]>();

function loadProjectFiles(projectPath: string): Promise<string[]> {
  const cached = FILE_CACHE.get(projectPath);
  if (cached) return Promise.resolve(cached);
  return invoke<string[]>("list_project_files", { projectPath })
    .then((files) => {
      FILE_CACHE.set(projectPath, files ?? []);
      return files ?? [];
    })
    .catch(() => {
      FILE_CACHE.set(projectPath, []);
      return [];
    });
}

// ── 触发检测 / 过滤 / 展开 ──────────────────────────────────────────────────

export type MentionTrigger = "skill" | "command" | "file";

/** 解析光标前的触发符 query；`trigger` 后不允许空格/换行。 */
export function parseTriggerQuery(
  textBefore: string,
  trigger: string,
): { start: number; query: string } | null {
  const idx = textBefore.lastIndexOf(trigger);
  if (idx === -1) return null;
  const query = textBefore.slice(idx + 1);
  if (query.includes(" ") || query.includes("\n")) return null;
  return { start: idx, query };
}

export type MentionItem =
  | { kind: "skill"; skill: Skill }
  | { kind: "command"; command: AgentCommand }
  | { kind: "file"; path: string };

function subsequenceMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let hi = 0;
  for (const ch of needle) {
    hi = haystack.indexOf(ch, hi);
    if (hi === -1) return false;
    hi += 1;
  }
  return true;
}

function fileBaseName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** 过滤候选项；query 为空返回全部（文件列表截断到 12 条）。 */
export function filterMentionItems(
  items: MentionItem[],
  query: string,
): MentionItem[] {
  const q = query.toLowerCase();
  if (!q) return items.slice(0, 12);
  const scored = items
    .map((item) => {
      let label: string;
      let detail: string;
      if (item.kind === "file") {
        label = fileBaseName(item.path);
        detail = item.path;
      } else if (item.kind === "skill") {
        label = item.skill.displayName || item.skill.name;
        detail = item.skill.description ?? "";
      } else {
        label = item.command.name;
        detail = item.command.description;
      }
      const labelLower = label.toLowerCase();
      let score = 0;
      if (labelLower === q) score = 100;
      else if (labelLower.startsWith(q)) score = 80;
      else if (labelLower.includes(q)) score = 60;
      else if (detail.toLowerCase().includes(q)) score = 40;
      else if (subsequenceMatch(labelLower, q)) score = 20;
      return { item, score };
    })
    .filter((s) => s.score > 0);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.item.kind === "file" ? fileBaseName(a.item.path) : "").localeCompare(
        b.item.kind === "file" ? fileBaseName(b.item.path) : "",
      ),
  );
  return scored.slice(0, 12).map((s) => s.item);
}

/** 选中候选项后展开/插入的文本。 */
export function expandMentionItem(item: MentionItem): string {
  if (item.kind === "skill") {
    const skill = item.skill;
    return `请读取并遵循 ${skill.displayName || skill.name} 技能：${skill.path}/SKILL.md`;
  }
  if (item.kind === "command") {
    return (
      `请执行 ${item.command.name} 命令：读取 ${item.command.path} 的内容，` +
      "并严格按照其中定义的流程与规则执行。"
    );
  }
  return `@${item.path}`;
}

// ── 浮层 ────────────────────────────────────────────────────────────────────

export function ComposerMentionPopover({
  visible,
  trigger,
  query,
  items,
  loading,
  index,
  onSetIndex,
  onSelect,
}: {
  visible: boolean;
  trigger: MentionTrigger | null;
  query: string;
  items: MentionItem[];
  loading: boolean;
  index: number;
  onSetIndex: (index: number) => void;
  onSelect: (item: MentionItem) => void;
}) {
  const { t } = useI18n();
  const optionRefs = useRef(new Map<number, HTMLDivElement>());

  // 键盘 ↑↓ 移动高亮时把选中项滚进可视区；block: "nearest" 保证鼠标 hover
  // 触发的 index 变化不会拽动滚动条（目标已在可视区内就不产生滚动）。
  useEffect(() => {
    optionRefs.current.get(index)?.scrollIntoView?.({ block: "nearest" });
  }, [index]);

  if (!visible) return null;
  return (
    <div style={s.mentionDropdown}>
      {loading ? (
        <div style={s.skillMentionHint}>{t("composer.mention.loading")}</div>
      ) : items.length === 0 ? (
        <div style={s.skillMentionHint}>
          {query
            ? t("composer.mention.noResults", { query })
            : trigger === "file"
              ? t("mention.startTyping")
              : t("composer.mention.startTyping")}
        </div>
      ) : (
        items.map((item, i) => {
          const icon =
            item.kind === "file" ? (
              <span style={s.skillMentionIcon}>
                {CODE_EXTS.has(
                  fileBaseName(item.path).includes(".")
                    ? fileBaseName(item.path).split(".").pop()!.toLowerCase()
                    : "",
                ) ? (
                  <FileCode2 size={12} />
                ) : (
                  <FileText size={12} />
                )}
              </span>
            ) : item.kind === "skill" ? (
              <span style={s.skillMentionIcon}>
                <Sparkles size={12} />
              </span>
            ) : (
              <span style={s.skillMentionIcon}>
                <SquareSlash size={12} />
              </span>
            );
          const name =
            item.kind === "file"
              ? fileBaseName(item.path)
              : item.kind === "skill"
                ? (item.skill.displayName || item.skill.name)
                : item.command.name;
          const detail =
            item.kind === "file"
              ? item.path
              : item.kind === "skill"
                ? (item.skill.description || item.skill.path)
                : item.command.description;
          return (
            <div
              key={
                item.kind === "file"
                  ? `file:${item.path}`
                  : item.kind === "skill"
                    ? `skill:${item.skill.name}`
                    : `cmd:${item.command.name}`
              }
              style={{
                ...s.mentionOption,
                background: i === index ? "var(--accent-subtle)" : "transparent",
              }}
              ref={(el) => {
                if (el) optionRefs.current.set(i, el);
                else optionRefs.current.delete(i);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item);
              }}
              onMouseEnter={() => onSetIndex(i)}
            >
              {icon}
              <span style={s.mentionOptionName}>{name}</span>
              <span style={s.mentionOptionDir}>{detail}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
// ── hook（textarea / input）────────────────────────────────────────────────

/**
 * composer 三触发符召唤 hook。宿主把 `handleKeyDown` 接进输入框的 onKeyDown
 * （先于提交逻辑调用，返回 true = 已消费），并在渲染层挂 `ComposerMentionPopover`。
 * `@` 文件列表按 projectPath 懒加载；`$` / `/` 列表挂载即加载。
 */
export function useComposerMention(
  fieldRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  valueRef: React.RefObject<string>,
  onChange: (next: string) => void,
  projectPath: string | null,
) {
  const [state, setState] = useState<{
    trigger: MentionTrigger;
    query: string;
    index: number;
  } | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const activeRef = useRef(false);
  const caretRef = useRef(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([loadSkills(), loadAgentCommands(projectPath)]).then(([sk, cmds]) => {
      if (cancelled) return;
      setSkills(sk);
      setCommands(cmds);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const fileMode = state?.trigger === "file";
  useEffect(() => {
    if (!fileMode || !projectPath) return;
    let cancelled = false;
    loadProjectFiles(projectPath).then((rows) => {
      if (!cancelled) setFiles(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [fileMode, projectPath]);

  const close = useCallback(() => {
    activeRef.current = false;
    setState(null);
  }, []);

  const items = useMemo((): MentionItem[] => {
    if (!state) return [];
    if (state.trigger === "skill")
      return filterMentionItems(
        skills.map((skill) => ({ kind: "skill" as const, skill })),
        state.query,
      );
    if (state.trigger === "command")
      return filterMentionItems(
        commands.map((command) => ({ kind: "command" as const, command })),
        state.query,
      );
    return filterMentionItems(
      files.map((path) => ({ kind: "file" as const, path })),
      state.query,
    );
  }, [commands, files, skills, state]);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  /** 输入/选区变化时调用：根据光标前文本决定弹层的触发符与 query。 */
  const syncFromCaret = useCallback(
    (caret: number) => {
      caretRef.current = caret;
      const before = (valueRef.current ?? "").slice(0, caret);
      // `$` 技能 → `/` 命令 → `@` 文件，后者要求 projectPath（无项目上下文不触发）
      const hit =
        parseTriggerQuery(before, "$") ??
        parseTriggerQuery(before, "/") ??
        (projectPath ? parseTriggerQuery(before, "@") : null);
      if (!hit) {
        if (activeRef.current) close();
        return;
      }
      const trigger: MentionTrigger =
        before[hit.start] === "$" ? "skill" : before[hit.start] === "/" ? "command" : "file";
      activeRef.current = true;
      setState((prev) =>
        prev && prev.trigger === trigger
          ? { ...prev, query: hit.query }
          : { trigger, query: hit.query, index: 0 },
      );
    },
    [close, projectPath, valueRef],
  );

  /** 用展开文本替换触发符片段，返回是否发生了替换。 */
  const applyItem = useCallback(
    (item: MentionItem): boolean => {
      const value = valueRef.current ?? "";
      const current = stateRef.current;
      if (!current) return false;
      const hit = parseTriggerQuery(value.slice(0, caretRef.current), triggerChar(current.trigger));
      if (!hit) return false;
      const expanded = expandMentionItem(item);
      const suffix = item.kind === "file" ? " " : "";
      const next = value.slice(0, hit.start) + expanded + suffix + value.slice(caretRef.current);
      const caret = hit.start + expanded.length + suffix.length;
      onChange(next);
      close();
      requestAnimationFrame(() => {
        const el = fieldRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      });
      return true;
    },
    [close, fieldRef, onChange, valueRef],
  );

  /**
   * 键盘处理：弹层打开且有候选时拦截 ↑↓/Enter/Tab/Escape，返回 true 表示已消费
   * （宿主应跳过自己的提交逻辑）。
   */
  const handleKeyDown = useCallback(
    (e: { key: string; shiftKey: boolean; preventDefault: () => void }): boolean => {
      if (!activeRef.current || itemsRef.current.length === 0) return false;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setState((prev) =>
          prev ? { ...prev, index: Math.min(prev.index + 1, itemsRef.current.length - 1) } : prev,
        );
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setState((prev) => (prev ? { ...prev, index: Math.max(prev.index - 1, 0) } : prev));
        return true;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
        e.preventDefault();
        const item = itemsRef.current[stateRef.current?.index ?? 0];
        if (item) applyItem(item);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [applyItem, close],
  );

  return {
    active: state !== null,
    trigger: state?.trigger ?? null,
    query: state?.query ?? "",
    items,
    loading,
    index: state?.index ?? 0,
    setIndex: (index: number) => setState((prev) => (prev ? { ...prev, index } : prev)),
    close,
    syncFromCaret,
    applyItem,
    handleKeyDown,
  };
}

function triggerChar(trigger: MentionTrigger): string {
  return trigger === "skill" ? "$" : trigger === "command" ? "/" : "@";
}
