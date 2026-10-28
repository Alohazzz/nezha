import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileCode2, FileText, Sparkles, SquareSlash } from "lucide-react";
import type { AgentCommand, Skill } from "../../types";
import { CODE_EXTS } from "../../utils";
import { skillToken } from "../../skillMention";
import { useI18n } from "../../i18n";
import s from "../../styles";

/**
 * composer 快捷召唤（参照 ZCode 的 slash-command 形态），支持三种触发符：
 * - `$query` 技能：选中后写入紧凑引用 `$name`，提交时再展开为
 *   「请读取并遵循 xxx 技能：<SKILL.md 路径>」（见 skillMention.ts）
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

// `$` 选择器用 list_composer_skills 合并视图（SkillHub + 用户级/项目级 agent 技能目录，
// 后端已按「项目级 > 用户级 > hub」同名去重）；缓存按 projectPath 分桶，
// 项目级技能随项目变化。浮层每次打开会后台重扫一次（见 useComposerMention），
// 不为用户级目录挂 watcher。
const SKILL_CACHE = new Map<string, Skill[]>();
const COMMAND_CACHE = new Map<string, AgentCommand[]>();

export function invalidateMentionCaches() {
  SKILL_CACHE.clear();
  COMMAND_CACHE.clear();
}

export function loadSkills(projectPath: string | null): Promise<Skill[]> {
  const key = projectPath ?? "";
  const cached = SKILL_CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  return invoke<Skill[]>("list_composer_skills", { projectPath: projectPath ?? null })
    .then((rows) => {
      const skills = rows ?? [];
      SKILL_CACHE.set(key, skills);
      return skills;
    })
    .catch((e) => {
      // 404（旧后端/未配置技能库）等错误按空列表处理，不打扰输入体验；
      // 失败结果同样入缓存，避免每次按键都撞同一个错
      console.warn("[composerMention] list_composer_skills failed:", e);
      SKILL_CACHE.set(key, []);
      return [];
    });
}

/** 同步读已加载的技能缓存：提交前展开 `$name` 用。合并各 projectPath 桶后
 * 按名去重——跨桶同名时后端已按来源择优，这里只做并集兜底。 */
export function peekCachedSkills(): Skill[] {
  const byName = new Map<string, Skill>();
  for (const skills of SKILL_CACHE.values()) {
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, skill);
    }
  }
  return [...byName.values()];
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

/** SkillOrigin → i18n 后缀键（composer.mention.origin.<key>）。 */
const ORIGIN_BADGE_KEY: Record<string, string> = {
  hub: "hub",
  codex: "codex",
  claude: "claude",
  agents: "agents",
  project: "project",
};

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
  | { kind: "builtin"; name: string; description: string }
  | { kind: "file"; path: string };

/** structured composer 内置斜杠命令的动作语义（对齐 Codex CLI TUI 同名能力）：
 * - picker：打开选择器浮层（/model /effort）；
 * - rpc：直接调后端命令（/compact /review）；
 * - stop：中断当前 turn（/stop，复用任务取消的中断语义但不收尾任务）。
 * description 由宿主注入 i18n 文案，这里只定命令名与动作类型。 */
export type BuiltinCommandAction = "picker:model" | "picker:effort" | "rpc:compact" | "rpc:review" | "stop";
export const BUILTIN_COMMANDS: readonly { name: string; action: BuiltinCommandAction }[] = [
  { name: "model", action: "picker:model" },
  { name: "effort", action: "picker:effort" },
  { name: "compact", action: "rpc:compact" },
  { name: "review", action: "rpc:review" },
  { name: "stop", action: "stop" },
];

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
      } else if (item.kind === "builtin") {
        label = item.name;
        detail = item.description;
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

/** `/` 弹层候选合并：内置命令排前（固定入口好找），同名时自定义命令优先
 * （用户自建 model.md 应胜过内置 /model）。 */
export function mergeBuiltinWithCommands(
  builtin: readonly { name: string; description: string }[],
  commands: readonly AgentCommand[],
): MentionItem[] {
  const names = new Set(commands.map((c) => c.name));
  const builtinItems: MentionItem[] = builtin
    .filter((cmd) => !names.has(cmd.name))
    .map((cmd) => ({ kind: "builtin" as const, name: cmd.name, description: cmd.description }));
  const commandItems: MentionItem[] = commands.map((command) => ({
    kind: "command" as const,
    command,
  }));
  return [...builtinItems, ...commandItems];
}

/** 选中候选项后插入的文本。builtin 命令不走文本展开（宿主拦截开选择器）。
 * 技能只写入紧凑引用 `$name`——canonical 指令（带 SKILL.md 路径）由提交前的
 * `expandSkillTokens` 生成，输入框里不再塞长句。 */
export function expandMentionItem(item: MentionItem): string {
  if (item.kind === "skill") {
    return skillToken(item.skill);
  }
  if (item.kind === "command") {
    return (
      `请执行 ${item.command.name} 命令：读取 ${item.command.path} 的内容，` +
      "并严格按照其中定义的流程与规则执行。"
    );
  }
  if (item.kind === "builtin") {
    return `/${item.name}`; // 兜底：宿主应拦截；未拦截时原样保留命令文本
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
                : item.kind === "builtin"
                  ? `/${item.name}`
                  : item.command.name;
          const detail =
            item.kind === "file"
              ? item.path
              : item.kind === "skill"
                ? (item.skill.description || item.skill.path)
                : item.kind === "builtin"
                  ? item.description
                  : item.command.description;
          const badge =
            item.kind === "skill" && item.skill.source
              ? ORIGIN_BADGE_KEY[item.skill.source]
              : null;
          return (
            <div
              key={
                item.kind === "file"
                  ? `file:${item.path}`
                  : item.kind === "skill"
                    ? `skill:${item.skill.name}`
                    : item.kind === "builtin"
                      ? `builtin:${item.name}`
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
              {badge ? (
                <span
                  style={s.mentionOriginBadge}
                  data-origin={badge}
                  title={t(`composer.mention.origin.${badge}`)}
                >
                  {t(`composer.mention.origin.${badge}`)}
                </span>
              ) : null}
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
  /** `/` 弹层前置注入的内置命令（structured composer 的 /model /effort）。
   *  旧调用方不传即维持原行为；选中 builtin 由宿主在 onSelect 里拦截。 */
  builtinCommands?: readonly { name: string; description: string }[],
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
    Promise.all([loadSkills(projectPath), loadAgentCommands(projectPath)]).then(([sk, cmds]) => {
      if (cancelled) return;
      setSkills(sk);
      setCommands(cmds);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // 技能列表挂载时加载一次后不再自动更新；agent 技能目录没有 watcher，
  // 借浮层每次打开（state 从 null 变为激活）后台重扫一次，命中缓存时零开销。
  const skillTriggerActive = state?.trigger === "skill";
  const reloadedOnceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!skillTriggerActive) {
      reloadedOnceRef.current = null;
      return;
    }
    const reloadKey = `${projectPath ?? ""}|${state?.query === "" ? "fresh" : "cached"}`;
    if (reloadedOnceRef.current === reloadKey) return;
    reloadedOnceRef.current = reloadKey;
    let cancelled = false;
    SKILL_CACHE.delete(projectPath ?? "");
    loadSkills(projectPath).then((sk) => {
      if (!cancelled) setSkills(sk);
    });
    return () => {
      cancelled = true;
    };
  }, [skillTriggerActive, projectPath, state?.query]);

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
    if (state.trigger === "command") {
      const merged = mergeBuiltinWithCommands(builtinCommands ?? [], commands);
      return filterMentionItems(merged, state.query);
    }
    return filterMentionItems(
      files.map((path) => ({ kind: "file" as const, path })),
      state.query,
    );
  }, [builtinCommands, commands, files, skills, state]);

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
    /** 已加载的技能清单：宿主提交时用它把 `$name` 展开成 canonical 指令。 */
    skills,
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
