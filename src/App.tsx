import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import { open as openDialog, confirm } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  Project,
  Task,
  TaskStatus,
  AgentType,
  PermissionMode,
  CodeupMr,
  ThemeMode,
  ThemeVariant,
  TerminalFontSize,
  TerminalScrollback,
  TaskDisplayWindow,
  SkillHubConfig,
  YunxiaoWorkitem,
  YunxiaoSupplement,
  YunxiaoWritebackDraft,
  YunxiaoWritebackResult,
  AgentEnabledState,
  BackfillIssueRequest,
  BackfillDraftEntry,
} from "./types";
import {
  isActiveTaskStatus,
  DEFAULT_TERMINAL_FONT_SIZE,
  clampTerminalFontSize,
  DEFAULT_TERMINAL_SCROLLBACK,
  clampTerminalScrollback,
  DEFAULT_TASK_DISPLAY_WINDOW,
  normalizeTaskDisplayWindow,
  firstEnabledAgent,
  isAgentEnabled,
} from "./types";
import { DEFAULT_UI_FONT, getDefaultMonoFont, isAutoDefaultMonoFont } from "./types";
import type {
  CreateKnowledgeIssueResult,
  FontFamily,
  KnowledgeSuggestion,
  KnowledgeWritebackResult,
} from "./types";
import { quoteFontName } from "./utils/fonts";
import {
  buildYunxiaoIssueLink,
  buildYunxiaoPrompt,
  buildYunxiaoTaskName,
  getLastYunxiaoAgent,
  getLastYunxiaoPermission,
  issueTag,
  isYunxiaoWorkitemImported,
  YUNXIAO_KNOWLEDGE_BASE_PROJECT_ID,
} from "./utils/yunxiao";
import { buildYunxiaoFieldsText } from "./components/yunxiao/issueForms";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type KnowledgeSettings,
  type YunxiaoSettings,
} from "./components/app-settings/types";
import { WelcomePage } from "./components/WelcomePage";
import { ProjectPage } from "./components/ProjectPage";
import { SKILL_HUB_CHANGED_EVENT } from "./components/app-settings/types";
import { KanbanView, OPEN_KANBAN_VIEW_EVENT } from "./components/KanbanView";
import { useToast } from "./components/Toast";
import { isHideWindowShortcut, isToggleKanbanShortcut } from "./shortcuts";
import { APP_PLATFORM } from "./platform";
import { useTerminalManager } from "./hooks/useTerminalManager";
import { useWorktreeDiffStats } from "./hooks/useWorktreeDiffStats";
import { useI18n } from "./i18n";
import {
  normalizeProjectNameInput,
  validateProjectName,
  type ProjectRenameResult,
} from "./projectName";
import {
  DARK_THEME_STORAGE_KEY,
  getNextThemeMode,
  getPreferredDarkTheme,
  getPreferredLightTheme,
  isDarkThemeMode,
  isLightThemeMode,
  isThemeMode,
  LIGHT_THEME_STORAGE_KEY,
  resolveThemeVariant,
  THEME_STORAGE_KEY,
  type DarkThemeMode,
  type LightThemeMode,
} from "./theme";
import s from "./styles";
import "./App.css";

function deriveProjectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) return path;

  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

async function persistProjects(
  projects: Project[],
  onError: (msg: string) => void,
  formatError: (error: string) => string,
): Promise<boolean> {
  try {
    await invoke("save_projects", { projects });
    return true;
  } catch (e: unknown) {
    console.error(e);
    onError(formatError(String(e)));
    return false;
  }
}

// 启动时任务加载失败(文件损坏/IO 错误)的项目。本次会话内禁止对这些项目
// 覆盖写盘——此时内存 state 是空的,一旦写出去会把磁盘上尚可人工恢复的
// 数据覆盖或清空。重启后重新加载成功即自动解除。
const taskPersistBlockedProjectIds = new Set<string>();

function persistProjectTasks(
  projectId: string,
  allTasks: Task[],
  onError: (msg: string) => void,
  formatError: (error: string, projectId: string) => string,
) {
  if (taskPersistBlockedProjectIds.has(projectId)) {
    onError(
      formatError(
        "tasks failed to load at startup; saving is disabled to protect on-disk data (restart to retry)",
        projectId,
      ),
    );
    return;
  }
  invoke("save_project_tasks", {
    projectId,
    tasks: allTasks.filter((t) => t.projectId === projectId),
  }).catch((e: unknown) => {
    console.error(e);
    onError(formatError(String(e), projectId));
  });
}

function persistProjectTasksQuietly(projectId: string, allTasks: Task[]) {
  if (taskPersistBlockedProjectIds.has(projectId)) return;
  invoke("save_project_tasks", {
    projectId,
    tasks: allTasks.filter((t) => t.projectId === projectId),
  }).catch(console.error);
}

// 老用户首次升级到拖拽排序版本时,把 projects 数组按 id 升序排一次并落盘,
// 让上来看到的 rail 顺序和旧版本(railProjects useMemo 里的 sort)一致。
// 之后用户拖拽产生的顺序由 projects 数组本身承载,不再排序。
const RAIL_PROJECTS_ORDERED_KEY = "nezha:rail-projects-ordered";

function isProjectsIdAscending(projects: Project[]): boolean {
  for (let i = 1; i < projects.length; i++) {
    if (Number(projects[i].id) < Number(projects[i - 1].id)) return false;
  }
  return true;
}

// 拖拽重排:beforeId === null 表示拖到 visible 末尾;draggedId === beforeId 视为无操作。
// visibleIds 是 rail 当前可见子集(过滤了 hiddenFromRail 与 hub),src/dst 在这个子序列
// 里算 — 直接在完整 projects 上 splice 会因为 hidden 项夹在中间而无声改写它们的相对位置
// (用户取消隐藏时会看到位置错乱)。重排后只回填到 visible 槽位,hidden 项原位保留。
// 返回新数组(若顺序无变化则返回原数组,方便 setState 早退)。
function reorderProjects(
  projects: Project[],
  visibleIds: string[],
  draggedId: string,
  beforeId: string | null,
): Project[] {
  if (draggedId === beforeId) return projects;

  const srcIdxV = visibleIds.indexOf(draggedId);
  if (srcIdxV === -1) return projects;

  const dstIdxV = beforeId === null ? visibleIds.length : visibleIds.indexOf(beforeId);
  if (dstIdxV === -1) return projects;

  const newVisibleOrder = [...visibleIds];
  const [dragged] = newVisibleOrder.splice(srcIdxV, 1);
  const adjustedDstIdxV = dstIdxV > srcIdxV ? dstIdxV - 1 : dstIdxV;
  newVisibleOrder.splice(adjustedDstIdxV, 0, dragged);

  const visibleSet = new Set(visibleIds);
  const projectById = new Map(projects.map((p) => [p.id, p] as const));
  let visibleCursor = 0;
  const next = projects.map((p) => {
    if (!visibleSet.has(p.id)) return p;
    const id = newVisibleOrder[visibleCursor++];
    return projectById.get(id) ?? p;
  });

  if (next.every((p, i) => p === projects[i])) return projects;
  return next;
}

interface ProjectViewState {
  selectedTaskId: string | null;
  isNewTask: boolean;
}

function createDefaultProjectViewState(): ProjectViewState {
  return { selectedTaskId: null, isNewTask: true };
}

function normalizeInterruptedTasksOnStartup(
  tasks: Task[],
  activeTaskIds: Set<string>,
): {
  tasks: Task[];
  changedProjectIds: Set<string>;
} {
  const interruptedAt = Date.now();
  const changedProjectIds = new Set<string>();
  const normalized = tasks.map((task) => {
    const hasLiveChild = activeTaskIds.has(task.id);
    if (!isActiveTaskStatus(task.status) && !(task.status === "interrupted" && hasLiveChild)) {
      return task;
    }

    if (hasLiveChild) {
      if (task.status === "detached") return task;
      changedProjectIds.add(task.projectId);
      return {
        ...task,
        status: "detached" as TaskStatus,
        updatedAt: interruptedAt,
        attentionRequestedAt: task.attentionRequestedAt ?? interruptedAt,
      };
    }

    if (task.status === "interrupted") return task;
    changedProjectIds.add(task.projectId);
    return {
      ...task,
      status: "interrupted" as TaskStatus,
      updatedAt: interruptedAt,
      attentionRequestedAt: task.attentionRequestedAt ?? interruptedAt,
    };
  });

  return { tasks: normalized, changedProjectIds };
}

function shouldIgnoreTaskStatusTransition(current: TaskStatus, next: TaskStatus): boolean {
  return (
    current === "detached" &&
    (next === "running" || next === "input_required" || next === "awaiting_review")
  );
}

function isLiveTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "input_required" ||
    status === "awaiting_review"
  );
}

function getSystemPrefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getInitialThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeMode(stored) ? stored : "system";
}

function getInitialLightThemeMode(): LightThemeMode {
  return getPreferredLightTheme(
    getInitialThemeMode(),
    localStorage.getItem(LIGHT_THEME_STORAGE_KEY),
  );
}

function getInitialDarkThemeMode(): DarkThemeMode {
  return getPreferredDarkTheme(getInitialThemeMode(), localStorage.getItem(DARK_THEME_STORAGE_KEY));
}

function getInitialTerminalFontSize(): TerminalFontSize {
  const stored = localStorage.getItem("nezha:terminalFontSize");
  if (stored == null) return DEFAULT_TERMINAL_FONT_SIZE;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clampTerminalFontSize(parsed) : DEFAULT_TERMINAL_FONT_SIZE;
}

function getInitialTaskDisplayWindow(): TaskDisplayWindow {
  const stored = localStorage.getItem("nezha:taskDisplayWindow");
  return stored == null ? DEFAULT_TASK_DISPLAY_WINDOW : normalizeTaskDisplayWindow(stored);
}

function getInitialAttentionBadge(): boolean {
  // 默认开启:项目栏显示待确认任务数量角标;关闭后回退为黄色小圆点
  return localStorage.getItem("nezha:attentionBadge") !== "0";
}

function getInitialFontFamily(key: string, fallback: FontFamily): FontFamily {
  const stored = localStorage.getItem(key);
  if (!stored) return fallback;
  // 老版本 useEffect 无差别把当时的 DEFAULT_MONO_FONT 写进 localStorage,
  // 导致默认更新对老用户无效。识别到历史自动默认值就清掉,改用当前平台默认。
  if (key === "nezha:monoFontFamily" && isAutoDefaultMonoFont(stored)) {
    localStorage.removeItem(key);
    return fallback;
  }
  // 旧版本写入的裸字体名（如 "Maple Mono NF CN"）在 Canvas 2D 下会被
  // tokenize 成多个 family 全部 miss；读出时统一 normalize 一次。
  return quoteFontName(stored);
}

/** 补录议题幂等签名：来源任务 + 来源议题 + 类别 + 标题 + 内容段 + 自定义字段。
 *  用于跨轮询/重复写入的「同一补录草稿不重复建」去重。 */
function deriveBackfillSignature(sourceTask: Task, draft: BackfillIssueRequest): string {
  const sections = draft.contentSections.map((s) => `${s.label}=${s.text}`).join("\n");
  const fields = draft.customFields
    .map((f) => `${f.fieldId}=${f.values.map((v) => v.identifier ?? "").join(",")}`)
    .join("\n");
  return [
    sourceTask.id,
    sourceTask.yunxiaoWorkitemId ?? "",
    draft.category,
    draft.subject,
    sections,
    fields,
  ].join("|");
}

function App() {
  const { showToast } = useToast();
  const { t } = useI18n();

  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [lightThemeMode, setLightThemeMode] = useState<LightThemeMode>(getInitialLightThemeMode);
  const [darkThemeMode, setDarkThemeMode] = useState<DarkThemeMode>(getInitialDarkThemeMode);
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const themeVariant: ThemeVariant = resolveThemeVariant(themeMode, systemPrefersDark);
  const [terminalFontSize, setTerminalFontSize] = useState<TerminalFontSize>(
    getInitialTerminalFontSize,
  );
  const [taskDisplayWindow, setTaskDisplayWindow] = useState<TaskDisplayWindow>(
    getInitialTaskDisplayWindow,
  );
  const [attentionBadge, setAttentionBadge] = useState<boolean>(getInitialAttentionBadge);
  const [terminalScrollback, setTerminalScrollbackState] = useState<TerminalScrollback>(
    DEFAULT_TERMINAL_SCROLLBACK,
  );
  const handleTerminalScrollbackChange = useCallback((value: TerminalScrollback) => {
    const clamped = clampTerminalScrollback(value);
    setTerminalScrollbackState(clamped);
    invoke("save_terminal_scrollback", { scrollback: clamped }).catch(console.error);
  }, []);
  const [uiFontFamily, setUiFontFamily] = useState<FontFamily>(() =>
    getInitialFontFamily("nezha:uiFontFamily", DEFAULT_UI_FONT),
  );
  const [monoFontFamily, setMonoFontFamily] = useState<FontFamily>(() =>
    getInitialFontFamily("nezha:monoFontFamily", getDefaultMonoFont()),
  );
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  // 补录议题轮询：tasks 与 handler 的最新引用 + 处理中任务去重集合（防重叠/陈旧闭包）。
  const tasksRef = useRef<Task[]>([]);
  const backfillHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const backfillProcessingRef = useRef<Set<string>>(new Set());
  tasksRef.current = tasks;
  backfillHandlerRef.current = handleScanBackfillDrafts;
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projectViews, setProjectViews] = useState<Record<string, ProjectViewState>>({});
  const [mountedProjectIds, setMountedProjectIds] = useState<string[]>([]);
  const [taskRunCounts, setTaskRunCounts] = useState<Record<string, number>>({});
  const [skillHubConfig, setSkillHubConfig] = useState<SkillHubConfig | null>(null);
  const [hubMode, setHubMode] = useState(false);
  const [showKanban, setShowKanban] = useState(false);

  const tm = useTerminalManager();
  const pendingResumeStartsRef = useRef<Record<string, () => void>>({});
  // 「恢复会话再发」时暂存的待发送输入：resume_task 启动的 PTY 会缓冲写入，
  // invoke 完成后补发 send_input 即可（决策 9）。
  const pendingResumeInputRef = useRef<Record<string, string>>({});
  // 由「合并审核」发起的 codeup 审查/冲突任务，任务结束后需清理临时 worktree。
  const codeupTaskCleanupRef = useRef<
    Record<
      string,
      { repository: string; mrId: number; repositoryId?: string; kind?: string }
    >
  >({});

  const formatSaveProjectsError = useCallback(
    (error: string) => t("toast.saveProjectsFailed", { error }),
    [t],
  );
  const formatSaveTasksError = useCallback(
    (error: string, projectId: string) => t("toast.saveTasksFailed", { error, projectId }),
    [t],
  );

  const persistTasksForHook = useCallback(
    (projectId: string, allTasks: Task[]) => {
      persistProjectTasks(projectId, allTasks, showToast, formatSaveTasksError);
    },
    [showToast, formatSaveTasksError],
  );
  const { scheduleForDoneTask } = useWorktreeDiffStats({
    projects,
    tasks,
    setTasks,
    persistTasks: persistTasksForHook,
  });

  const mountProject = useCallback((projectId: string) => {
    setMountedProjectIds((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));
  }, []);

  const updateProjectView = useCallback((projectId: string, patch: Partial<ProjectViewState>) => {
    setProjectViews((prev) => ({
      ...prev,
      [projectId]: {
        ...createDefaultProjectViewState(),
        ...prev[projectId],
        ...patch,
      },
    }));
  }, []);

  const clearProjectView = useCallback((projectId: string) => {
    setProjectViews((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  function getProjectView(projectId: string): ProjectViewState {
    return projectViews[projectId] ?? createDefaultProjectViewState();
  }

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (event: MediaQueryListEvent) => setSystemPrefersDark(event.matches);

    setSystemPrefersDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);

    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useLayoutEffect(() => {
    const root = document.documentElement;
    // The midnight variant layers on top of the dark token set: it keeps the
    // `dark` class (so it inherits every dark token) and adds `midnight` for the
    // few near-black overrides (menu border / surface backgrounds) declared later
    // in themes.css, which win by source order at equal specificity.
    root.classList.toggle("dark", themeVariant === "dark" || themeVariant === "midnight");
    root.classList.toggle("midnight", themeVariant === "midnight");
    root.classList.toggle("eyecare", themeVariant === "eyecare");
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeVariant, themeMode]);

  useEffect(() => {
    localStorage.setItem(LIGHT_THEME_STORAGE_KEY, lightThemeMode);
  }, [lightThemeMode]);

  useEffect(() => {
    localStorage.setItem(DARK_THEME_STORAGE_KEY, darkThemeMode);
  }, [darkThemeMode]);

  useEffect(() => {
    // Tauri window theme only understands light/dark/null; map eyecare to light
    // so the native chrome (titlebar, scrollbars) stays in the light family.
    const nativeTheme =
      themeMode === "system"
        ? null
        : themeMode === "dark" || themeMode === "midnight"
          ? "dark"
          : "light";
    getCurrentWindow().setTheme(nativeTheme).catch(console.error);
  }, [themeMode]);

  useEffect(() => {
    // Cmd+W 收起窗口（隐藏到 Dock），仅 macOS 启用：隐藏后点 Dock 图标可唤回
    // （见 lib.rs Reopen）。其他平台没有 Dock/托盘唤回入口，隐藏后窗口会丢失，故不启用。
    // 在捕获阶段拦截，先于 xterm 等组件的 keydown 处理，避免被吞掉。
    if (APP_PLATFORM !== "macos") return;
    function handleHideWindow(event: KeyboardEvent) {
      if (!isHideWindowShortcut(event, APP_PLATFORM)) return;
      event.preventDefault();
      // 走后端命令收起窗口：全屏时需先退出全屏再隐藏，否则会留下黑屏的空 Space。
      invoke("hide_main_window").catch(console.error);
    }
    window.addEventListener("keydown", handleHideWindow, true);
    return () => window.removeEventListener("keydown", handleHideWindow, true);
  }, []);

  useEffect(() => {
    // Cmd+K (macOS) / Alt+K (其他平台) 切换看板浮层。全平台启用——平台差异由
    // isToggleKanbanShortcut 内部处理（非 mac 用 Alt 以避开终端 Ctrl+K / Ctrl+Shift+C）。
    // 捕获阶段拦截，先于 xterm 处理；浮层内的 Esc 关闭仍由 KanbanView 自己负责。
    function handleToggleKanban(event: KeyboardEvent) {
      if (!isToggleKanbanShortcut(event, APP_PLATFORM)) return;
      event.preventDefault();
      setShowKanban((prev) => !prev);
    }
    window.addEventListener("keydown", handleToggleKanban, true);
    return () => window.removeEventListener("keydown", handleToggleKanban, true);
  }, []);

  useEffect(() => {
    localStorage.setItem("nezha:terminalFontSize", String(terminalFontSize));
  }, [terminalFontSize]);

  useEffect(() => {
    let cancelled = false;
    invoke<{ terminal_scrollback?: unknown }>("load_app_settings")
      .then((settings) => {
        if (cancelled) return;
        setTerminalScrollbackState(clampTerminalScrollback(settings.terminal_scrollback));
      })
      .catch(() => {
        /* 默认 1000 已经在 state 初值,无需 fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("nezha:taskDisplayWindow", String(taskDisplayWindow));
  }, [taskDisplayWindow]);

  useEffect(() => {
    localStorage.setItem("nezha:attentionBadge", attentionBadge ? "1" : "0");
  }, [attentionBadge]);

  useEffect(() => {
    const value = uiFontFamily.trim() || DEFAULT_UI_FONT;
    localStorage.setItem("nezha:uiFontFamily", value);
    document.documentElement.style.setProperty("--font-ui", value);
  }, [uiFontFamily]);

  useEffect(() => {
    const trimmed = monoFontFamily.trim();
    const effective = trimmed || getDefaultMonoFont();
    // 用户没显式自定义时不写入 localStorage,避免把默认值固化、
    // 导致后续改默认对老用户失效（这正是历史 bug 的根因）。
    if (!trimmed || isAutoDefaultMonoFont(trimmed)) {
      localStorage.removeItem("nezha:monoFontFamily");
    } else {
      localStorage.setItem("nezha:monoFontFamily", trimmed);
    }
    document.documentElement.style.setProperty("--font-mono", effective);
  }, [monoFontFamily]);

  const handleThemeModeChange = useCallback((mode: ThemeMode) => {
    if (isLightThemeMode(mode)) setLightThemeMode(mode);
    if (isDarkThemeMode(mode)) setDarkThemeMode(mode);
    setThemeMode(mode);
  }, []);

  const handleToggleTheme = useCallback(() => {
    setThemeMode((currentMode) => {
      return getNextThemeMode(currentMode, systemPrefersDark, lightThemeMode, darkThemeMode);
    });
  }, [darkThemeMode, lightThemeMode, systemPrefersDark]);

  useEffect(() => {
    async function init() {
      // Load projects from ~/.nezha/projects.json
      const loadedProjects = await invoke<Project[]>("load_projects");

      // 仅在首次升级到拖拽版本时做一次性顺序迁移:若 projects.json 不是
      // id 升序(老版本 handleOpen 把新项目插到首位,所以多半是降序),
      // 重排成 id 升序并落盘,与旧版 railProjects 的视觉顺序保持一致。
      // 之后顺序由用户拖拽决定,不再触发此分支。
      const alreadyOrdered = localStorage.getItem(RAIL_PROJECTS_ORDERED_KEY) === "1";
      const projectsForState =
        alreadyOrdered || isProjectsIdAscending(loadedProjects)
          ? loadedProjects
          : [...loadedProjects].sort((a, b) => Number(a.id) - Number(b.id));
      if (!alreadyOrdered) {
        // flag 必须在写盘成功后才落:否则一次磁盘失败 → flag 已锁 → 下次启动跳过
        // 迁移 → 老用户 rail 顺序永久错乱。无需写盘的分支可直接 set。
        if (projectsForState !== loadedProjects) {
          invoke("save_projects", { projects: projectsForState })
            .then(() => {
              localStorage.setItem(RAIL_PROJECTS_ORDERED_KEY, "1");
            })
            .catch((e: unknown) => {
              console.error(e);
              showToast(formatSaveProjectsError(String(e)));
            });
        } else {
          localStorage.setItem(RAIL_PROJECTS_ORDERED_KEY, "1");
        }
      }
      setProjects(projectsForState);

      // Load tasks for all known projects。allSettled 隔离单项目失败:
      // 一个 tasks.json 损坏不能让所有项目的任务在 UI 里消失(Promise.all
      // 整体 reject 曾造成这个假象),失败项目单独提示并禁止写盘。
      const results = await Promise.allSettled(
        loadedProjects.map((p) => invoke<Task[]>("load_project_tasks", { projectId: p.id })),
      );
      const chunks: Task[][] = [];
      results.forEach((result, i) => {
        if (result.status === "fulfilled") {
          chunks.push(result.value);
          return;
        }
        const project = loadedProjects[i];
        taskPersistBlockedProjectIds.add(project.id);
        console.error(result.reason);
        showToast(t("toast.loadTasksFailed", { name: project.name, error: String(result.reason) }));
      });
      const activeTaskIds = new Set(await invoke<string[]>("get_active_task_ids"));
      const { tasks: loadedTasks, changedProjectIds } = normalizeInterruptedTasksOnStartup(
        chunks.flat(),
        activeTaskIds,
      );
      setTasks(loadedTasks);
      changedProjectIds.forEach((projectId) => {
        persistProjectTasksQuietly(projectId, loadedTasks);
      });
    }

    init().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // 用 backend 列表作为内容权威,但顺序以 prev 为准:用户拖拽产生的顺序保存在
    // 前端 state 里,不能被一次后台 reload 还原。共有项的字段由 authoritative 覆盖;
    // prev 独有的(尚未持久化)条目保留;authoritative 独有的(skill hub 等新增)
    // 追加到末尾。
    const mergeProjects = (authoritative: Project[]) => {
      setProjects((prev) => {
        const authMap = new Map<string, Project>();
        authoritative.forEach((p) => authMap.set(p.id, p));
        const seenIds = new Set<string>();
        const next: Project[] = [];
        for (const p of prev) {
          const auth = authMap.get(p.id);
          if (auth !== undefined) {
            next.push(auth);
            seenIds.add(p.id);
          } else {
            next.push(p);
          }
        }
        for (const p of authoritative) {
          if (!seenIds.has(p.id)) next.push(p);
        }
        return next;
      });
    };

    const loadFromBackend = () => {
      Promise.all([
        invoke<SkillHubConfig>("get_skill_hub_config"),
        invoke<Project[]>("load_projects"),
      ])
        .then(([cfg, loadedProjects]) => {
          setSkillHubConfig(cfg ?? null);
          mergeProjects(loadedProjects);
        })
        .catch(console.error);
    };

    const handleSkillHubChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ projects?: Project[] }>).detail;
      if (detail?.projects && Array.isArray(detail.projects)) {
        // 同步路径：set_skill_hub_path 已返回完整列表，直接 merge，避免竞态
        invoke<SkillHubConfig>("get_skill_hub_config")
          .then((cfg) => setSkillHubConfig(cfg ?? null))
          .catch(console.error);
        mergeProjects(detail.projects);
        return;
      }
      // clear_skill_hub 等场景没有 projects payload，退回到全量 reload
      loadFromBackend();
    };

    loadFromBackend();
    window.addEventListener(SKILL_HUB_CHANGED_EVENT, handleSkillHubChanged);
    return () => window.removeEventListener(SKILL_HUB_CHANGED_EVENT, handleSkillHubChanged);
  }, []);

  // Tauri event listeners (agent-output is handled inside useTerminalManager)
  useEffect(() => {
    const p1 = listen<{ task_id: string; status: TaskStatus; failure_reason?: string }>(
      "task-status",
      (e) => {
        const { task_id, status, failure_reason } = e.payload;
        updateTaskStatus(task_id, status, undefined, failure_reason);
        if (!isActiveTaskStatus(status)) {
          tm.removeTaskBuffers([task_id]);
          // 合并审核发起的任务：结束后清理该 MR 的临时 worktree。
          const codeupCleanup = codeupTaskCleanupRef.current[task_id];
          if (codeupCleanup) {
            delete codeupTaskCleanupRef.current[task_id];
            if (codeupCleanup.kind === "merge" && status === "done") {
              // 分支合并任务：已由 Agent 用 git 将合并结果推送到目标分支完成合并，无需再调 Codeup 接口。
              showToast("MR 已通过 git 推送合并到目标分支", "success");
              invoke("codeup_cleanup_mr", {
                repository: codeupCleanup.repository,
                mrId: String(codeupCleanup.mrId),
              }).catch(() => {});
            } else {
              invoke("codeup_cleanup_mr", {
                repository: codeupCleanup.repository,
                mrId: String(codeupCleanup.mrId),
              }).catch(() => {});
            }
          }
        }
        if (status === "done") scheduleForDoneTask(task_id);
      },
    );
    const p2 = listen<{ task_id: string; session_id: string; session_path: string }>(
      "task-session",
      (e) => {
        const { task_id, session_id, session_path } = e.payload;
        updateTaskSession(task_id, session_id, session_path);
      },
    );
    return () => {
      p1.then((fn) => fn());
      p2.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    const path = selected as string;
    const existing = projects.find((p) => p.path === path);
    const project: Project = existing
      ? { ...existing, lastOpenedAt: Date.now() }
      : { id: `${Date.now()}`, name: deriveProjectName(path), path, lastOpenedAt: Date.now() };
    setProjects((prev) => {
      const next = existing ? prev.map((p) => (p.path === path ? project : p)) : [project, ...prev];
      persistProjects(next, showToast, formatSaveProjectsError);
      return next;
    });
    setActiveProject(project);
    mountProject(project.id);
    updateProjectView(project.id, createDefaultProjectViewState());
    invoke("init_project_config", { projectPath: path }).catch((e: unknown) => {
      showToast(t("toast.initProjectConfigFailed", { error: String(e) }), "warning");
    });
  }

  function handleProjectClick(project: Project) {
    const updated = { ...project, lastOpenedAt: Date.now() };
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === project.id ? updated : p));
      persistProjects(next, showToast, formatSaveProjectsError);
      return next;
    });
    setActiveProject(updated);
    setHubMode(false);
    mountProject(updated.id);
    invoke("init_project_config", { projectPath: project.path }).catch((e: unknown) => {
      showToast(t("toast.initProjectConfigFailed", { error: String(e) }), "warning");
    });
  }

  function handleBack() {
    setActiveProject(null);
    setHubMode(false);
  }

  function invokeRunTask(
    task: Task,
    projectPath: string,
    images: string[],
    texts: string[] = [],
    realProjectPath: string,
  ) {
    invoke("run_task", {
      taskId: task.id,
      taskName: task.name ?? "",
      projectPath,
      realProjectPath,
      prompt: task.prompt,
      agent: task.agent,
      permissionMode: task.permissionMode,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      images,
      texts,
      cols: tm.terminalSizeRef.current.cols,
      rows: tm.terminalSizeRef.current.rows,
      onOutput: tm.createOutputChannel(task.id),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      tm.writeErrorToTerminal(task.id, `\r\nError: ${msg}\r\n`);
      updateTaskStatus(task.id, "failed", undefined, msg);
    });
  }

  async function handleSubmitTask(
    project: Project,
    {
      prompt,
      agent,
      permissionMode,
      model,
      reasoningEffort,
      images,
      texts,
      immediate,
      launchMode,
      baseBranch,
      repoPath,
    }: {
      prompt: string;
      agent: AgentType;
      permissionMode: PermissionMode;
      model?: string;
      reasoningEffort?: string;
      images: string[];
      texts: string[];
      immediate: boolean;
      launchMode: "local" | "worktree";
      baseBranch: string;
      /** 任务关联的 git 根（worktree 创建于此目录的 .nezha/worktrees）。
       *  缺省时回落 project.path，向后兼容老调用方。 */
      repoPath?: string;
    },
  ) {
    const effectiveRepoPath = repoPath ?? project.path;
    const taskId = `${Date.now()}`;

    if (launchMode === "worktree" && !baseBranch) {
      showToast(t("toast.worktreeBaseRequired"), "warning");
      return;
    }

    // 1) 立即把任务推到 state 让 view 切到 RunningView。worktree 字段先留空，
    //    避免 await create_task_worktree 期间用户停留在 NewTaskView，让人误以为没反应。
    const now = Date.now();
    const baseTask: Task = {
      id: taskId,
      projectId: project.id,
      prompt,
      name: prompt ? undefined : `task-${taskId}`,
      agent,
      permissionMode,
      model,
      reasoningEffort,
      status: immediate ? "pending" : "todo",
      createdAt: now,
      updatedAt: now,
    };
    setTasks((prev) => {
      const next = [baseTask, ...prev];
      persistProjectTasks(baseTask.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    setActiveProject(project);
    mountProject(project.id);
    updateProjectView(project.id, { selectedTaskId: taskId, isNewTask: false });

    if (!immediate) return;

    // 2) 终端 buffer 在 PTY 启动前就要建好，否则首批输出会进不来 buffer。
    tm.resetTaskTerminal(taskId);

    // 3) 如果是 worktree 模式，先创建 worktree，成功后把字段补回 task 再启动 PTY。
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;
    let resolvedBaseBranch: string | undefined;

    if (launchMode === "worktree") {
      try {
        const created = await invoke<{
          worktreePath: string;
          worktreeBranch: string;
          baseBranch: string;
        }>("create_task_worktree", {
          projectPath: project.path,
          repoPath: effectiveRepoPath,
          taskId,
          baseBranch,
        });
        worktreePath = created.worktreePath;
        worktreeBranch = created.worktreeBranch;
        resolvedBaseBranch = created.baseBranch;

        setTasks((prev) => {
          const next = prev.map((tk) =>
            tk.id === taskId
              ? {
                  ...tk,
                  worktreePath,
                  worktreeBranch,
                  baseBranch: resolvedBaseBranch,
                  worktreeRepo: effectiveRepoPath,
                }
              : tk,
          );
          persistProjectTasks(baseTask.projectId, next, showToast, formatSaveTasksError);
          return next;
        });
      } catch (e) {
        showToast(t("toast.worktreeCreateFailed", { error: String(e) }), "error");
        // 回滚刚加的占位 task
        setTasks((prev) => {
          const next = prev.filter((tk) => tk.id !== taskId);
          persistProjectTasks(baseTask.projectId, next, showToast, formatSaveTasksError);
          return next;
        });
        tm.removeTaskBuffers([taskId]);
        return;
      }
    }

    // Agent cwd 恒为 project.path（workspace 根）——多 repo 项目下 agent 才能同时看到所有 sub-repo。
    // sub-repo picker（effectiveRepoPath）只用于 git 面板 / branch bar / worktree 落地位置，
    // 不参与 agent 启动路径；worktree 模式仍以 worktree 路径为 cwd（隔离语义生效）。
    invokeRunTask(
      {
        ...baseTask,
        worktreePath,
        worktreeBranch,
        baseBranch: resolvedBaseBranch,
        worktreeRepo: worktreePath ? effectiveRepoPath : undefined,
      },
      worktreePath ?? project.path,
      images,
      texts,
      project.path,
    );
  }

  /** 合并审核：点「代码审查/处理冲突」时，在 MR 对应项目里发起一个真实任务（codex + YOLO + 全新临时 worktree）。 */
  async function startCodeupTask(mr: CodeupMr, kind: "review" | "conflict" | "merge") {
    let project = projects.find((p) => p.path === mr.projectPath) ?? null;
    // 该 MR 的仓库未注册为 Nezha 项目时，自动把后端给出的固定文件夹路径注册成一个项目，
    // 让「代码审查 / 处理冲突」能自动定位到对应代码文件夹，无需手动添加。
    if (!project && mr.projectPath) {
      project = {
        id: `${Date.now()}`,
        name: deriveProjectName(mr.projectPath),
        path: mr.projectPath,
        lastOpenedAt: Date.now(),
      };
      setProjects((prev) => {
        const next = [project!, ...prev];
        persistProjects(next, showToast, formatSaveProjectsError);
        return next;
      });
    }
    if (!project) {
      showToast("找不到该 MR 对应的本地项目，请先将其注册为 Nezha 项目", "error");
      return;
    }

    // 2) 组装任务 prompt。
    let prompt: string;
    if (kind === "review") {
      prompt =
        `──── 代码审查（规则与输出由 \`merge-code-review\` 技能统一管理）────\n` +
        `请读取并遵循 \`merge-code-review\` 技能：\`~/.codex/skills/merge-code-review/SKILL.md\`（审查规范在 \`references/csharp-dev-manual.md\`）。对 \`git diff origin/${mr.targetBranch}...origin/${mr.sourceBranch}\` 的改动按技能规则逐项审查；读文件内容用 \`git show origin/${mr.sourceBranch}:<path>\`。\n` +
        `不要输出结构化 <REVIEW> JSON 数组。请汇总本次改动发现的全部问题，写出一份**对人可读的整体审查总结报告**：按规则分组、标注严重程度（warn/fail）、文件路径与行号、问题说明与修改建议，并在报告末尾给出「是否可合并」结论。\n` +
        `完成后把该 Markdown 报告写入当前工作区 \`.nezha/review-report-${mr.localId}.md\`（用相对工作区根路径，不要写绝对路径）。`;
    } else if (kind === "merge") {
      prompt =
        `你是 MR 合并助手。请仅用 git 命令在当前工作区完成把 ${mr.sourceBranch} 合并进 ${mr.targetBranch}，不要调用任何接口/平台合并功能：\n` +
        `1. 运行 \`git fetch origin ${mr.sourceBranch} origin/${mr.targetBranch}\`\n` +
        `2. 运行 \`git checkout ${mr.sourceBranch}\`（已在该分支则跳过）\n` +
        `3. 运行 \`git merge --no-commit --no-ff origin/${mr.targetBranch}\`；若有冲突，修改代码解决；没有冲突也保留合并结果，不要执行 \`git merge --abort\`\n` +
        `4. 运行 \`git add -A\` 与 \`git commit -m "merge ${mr.targetBranch} into ${mr.sourceBranch}"\`\n` +
        `5. 运行 \`git push origin HEAD:${mr.targetBranch}\`，把合并结果直接推送到目标分支从而完成合并\n` +
        `完成后简要说明结果。`;
    } else {
      prompt =
        `你是合并冲突解决助手。请在当前工作区按步骤完成并把结果推回源分支：\n` +
        `1. 运行 \`git fetch origin ${mr.targetBranch}\`\n` +
        `2. 运行 \`git merge --no-commit --no-ff origin/${mr.targetBranch}\`\n` +
        `3. 若存在冲突，修改代码解决冲突；若无冲突，执行 \`git merge --abort\` 并告知无冲突\n` +
        `4. 解决后运行 \`git add -A\` 与 \`git commit -m "resolve merge conflicts"\`\n` +
        `5. 运行 \`git push origin HEAD:${mr.sourceBranch}\`\n` +
        `完成后简要说明结果。`;
    }

    // 3) 先建任务并立即切换到该项目 RunningView（不等 worktree，避免点下去长时间无跳转）。
    const taskId = `${Date.now()}`;
    const now = Date.now();
    const task: Task = {
      id: taskId,
      projectId: project.id,
      name:
        kind === "review"
          ? `代码审查 ${mr.title}`
          : kind === "merge"
            ? `分支合并 ${mr.title}`
            : `处理冲突 ${mr.title}`,
      prompt,
      agent: "codex",
      permissionMode: "full_access", // YOLO
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    setTasks((prev) => {
      const next = [task, ...prev];
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    setActiveProject(project);
    mountProject(project.id);
    updateProjectView(project.id, { selectedTaskId: taskId, isNewTask: false });
    tm.resetTaskTerminal(taskId);
    // 任务结束后清理该 MR 的代码文件夹/审查结果（step 3 已先建任务，这里补登记）。
    codeupTaskCleanupRef.current[taskId] = {
      repository: mr.repository,
      mrId: mr.localId,
      repositoryId: mr.repositoryId,
      kind,
    };

    // 4) 后台创建该 MR 的代码文件夹（fetch 源/目标分支 + checkout 源分支）。
    // 对 HIS 这类大仓库首次可能是全量 clone，耗时较长；立即写一行进度到终端，
    // 避免任务停在 RunningView 却长时间「无反应」，让用户误以为没点成功。
    tm.writeErrorToTerminal(
      taskId,
      `\r\n正在准备代码文件夹（拉取源/目标分支并切到源分支）…\r\n`,
    );
    let worktreePath: string;
    try {
      worktreePath = await invoke<string>("codeup_pull_code", {
        repository: mr.repository,
        sourceBranch: mr.sourceBranch,
        targetBranch: mr.targetBranch,
        mrId: String(mr.localId),
      });
    } catch (e) {
      const msg = `创建代码文件夹失败: ${String(e)}`;
      showToast(msg, "error");
      tm.writeErrorToTerminal(taskId, `\r\n${msg}\r\n`);
      delete codeupTaskCleanupRef.current[taskId];
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== taskId);
        persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
        return next;
      });
      tm.removeTaskBuffers([taskId]);
      return;
    }
    tm.writeErrorToTerminal(taskId, `\r\n代码文件夹已就绪，正在启动审查 Agent…\r\n`);
    const worktreeTask: Task = {
      ...task,
      worktreePath,
      worktreeBranch: mr.sourceBranch,
      baseBranch: mr.targetBranch,
      worktreeRepo: project.path,
    };
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === taskId ? worktreeTask : t));
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    invokeRunTask(worktreeTask, worktreePath, [], [], project.path);
  }

  function handleRunTodoTask(task: Task) {
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;

    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: "pending" as TaskStatus,
              updatedAt: Date.now(),
              attentionRequestedAt: undefined,
            }
          : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    tm.resetTaskTerminal(task.id);
    updateProjectView(task.projectId, { selectedTaskId: task.id, isNewTask: false });
    invokeRunTask(task, task.worktreePath ?? project.path, [], [], project.path);
  }

  function markTaskWorktreeDiscarded(taskId: string) {
    setTasks((prev) => {
      const task = prev.find((x) => x.id === taskId);
      if (!task) return prev;
      const next = prev.map((x) => (x.id === taskId ? { ...x, worktreeDiscarded: true } : x));
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  async function handleMergeWorktree(taskId: string) {
    const task = tasks.find((x) => x.id === taskId);
    if (!task || !task.worktreePath || !task.worktreeBranch || !task.baseBranch) return;
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;
    try {
      await invoke("merge_task_worktree", {
        projectPath: project.path,
        repoPath: task.worktreeRepo ?? project.path,
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
        baseBranch: task.baseBranch,
        expectedIssueTag: task.yunxiaoSerialNumber
          ? issueTag(task.yunxiaoSerialNumber)
          : undefined,
      });
      // 合并成功后顺手把 worktree 与分支清掉，避免遗留残留
      await invoke("remove_task_worktree", {
        projectPath: project.path,
        repoPath: task.worktreeRepo ?? project.path,
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
      }).catch(() => {});
      markTaskWorktreeDiscarded(taskId);
    } catch (e) {
      showToast(t("toast.worktreeMergeFailed", { error: String(e) }), "error");
    }
  }

  async function handleDiscardWorktree(taskId: string) {
    const task = tasks.find((x) => x.id === taskId);
    if (!task || !task.worktreePath || !task.worktreeBranch) return;
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;
    const ok = await confirm(t("task.discardWorktreePrompt", { branch: task.worktreeBranch }), {
      title: t("task.discardWorktreeTitle"),
      kind: "warning",
    });
    if (!ok) return;
    try {
      await invoke("remove_task_worktree", {
        projectPath: project.path,
        repoPath: task.worktreeRepo ?? project.path,
        worktreePath: task.worktreePath,
        branch: task.worktreeBranch,
      });
      markTaskWorktreeDiscarded(taskId);
    } catch (e) {
      showToast(t("toast.worktreeDiscardFailed", { error: String(e) }), "error");
    }
  }

  function handleCancelTask(taskId: string) {
    delete pendingResumeStartsRef.current[taskId];
    const task = tasks.find((t) => t.id === taskId);
    const project = projects.find((p) => p.id === task?.projectId);
    const projectPath = task?.worktreePath ?? project?.path ?? "";
    invoke("cancel_task", { taskId, projectPath }).catch((e: unknown) => {
      showToast(t("toast.cancelTaskFailed", { error: String(e) }));
    });
  }

  function invokeResumeTask(task: Task, project: Project, sessionId: string) {
    invoke("resume_task", {
      taskId: task.id,
      taskName: task.name ?? "",
      projectPath: task.worktreePath ?? project.path,
      realProjectPath: project.path,
      agent: task.agent,
      sessionId,
      prompt: task.prompt,
      permissionMode: task.permissionMode,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      cols: tm.terminalSizeRef.current.cols,
      rows: tm.terminalSizeRef.current.rows,
      onOutput: tm.createOutputChannel(task.id),
    })
      .then(() => {
        // resume 启动的 PTY 缓冲输入，任务就绪后自动补发待发送的评论消息。
        const pendingInput = pendingResumeInputRef.current[task.id];
        if (pendingInput !== undefined) {
          delete pendingResumeInputRef.current[task.id];
          invoke("send_input", { taskId: task.id, data: pendingInput }).catch(console.error);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        tm.writeErrorToTerminal(task.id, `\r\nError: ${msg}\r\n`);
        updateTaskStatus(task.id, "failed", undefined, msg);
      });
  }

  function queueResumeTask(taskId: string, afterStart?: () => void) {
    const task = tasks.find((t) => t.id === taskId);
    const sessionId =
      task?.agent === "codex"
        ? task.codexSessionId
        : task?.agent === "dsh"
          ? task.dshSessionId
          : task?.claudeSessionId;
    if (!task) return;
    if (task.agent !== "dsh" && !sessionId) {
      showToast(t("running.resumeUnavailable"), "warning");
      return;
    }
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;

    // Reset task status, clear buffer, and bump run counter to remount the terminal
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: "pending" as TaskStatus,
              updatedAt: Date.now(),
              attentionRequestedAt: undefined,
            }
          : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    tm.resetTaskTerminal(taskId);
    setTaskRunCounts((prev) => ({ ...prev, [taskId]: (prev[taskId] ?? 0) + 1 }));

    pendingResumeStartsRef.current[taskId] = () => {
      if (afterStart) afterStart();
      invokeResumeTask(task, project, sessionId ?? "");
    };
  }

  function handleResumeTask(taskId: string) {
    // 云效任务恢复：附件目录可能在任务完成/取消时已清理，prompt 里的图片路径可能失效
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task?.yunxiaoWorkitemId && task.prompt.includes("[Attached images]")) {
      showToast(t("yunxiao.images.cleanupHint"), "warning");
    }
    queueResumeTask(taskId);
  }

  /** 任务已结束时的「恢复会话再发」：resume 启动后自动把评论消息写入 PTY */
  function handleResumeTaskAndSend(taskId: string, input: string) {
    queueResumeTask(taskId, () => {
      pendingResumeInputRef.current[taskId] = input;
    });
  }

  function invokeForkTask(task: Task, project: Project, sourceSessionId: string) {
    invoke("fork_task", {
      taskId: task.id,
      projectPath: project.path,
      agent: task.agent,
      sourceSessionId,
      permissionMode: task.permissionMode,
      model: task.model,
      reasoningEffort: task.reasoningEffort,
      cols: tm.terminalSizeRef.current.cols,
      rows: tm.terminalSizeRef.current.rows,
      onOutput: tm.createOutputChannel(task.id),
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      tm.writeErrorToTerminal(task.id, `\r\nError: ${msg}\r\n`);
      updateTaskStatus(task.id, "failed", undefined, msg);
    });
  }

  function handleForkTask(sourceTaskId: string, requestedName: string) {
    const sourceTask = tasks.find((task) => task.id === sourceTaskId);
    if (!sourceTask) return;
    if (sourceTask.worktreePath) {
      showToast(t("running.forkWorktreeUnsupported"), "warning");
      return;
    }

    const sourceSessionId =
      sourceTask.agent === "codex"
        ? sourceTask.codexSessionId
        : sourceTask.agent === "dsh"
          ? sourceTask.dshSessionId
          : sourceTask.claudeSessionId;
    if (sourceTask.agent !== "dsh" && !sourceSessionId) {
      showToast(t("running.forkUnavailable"), "warning");
      return;
    }
    const name = requestedName.trim();
    if (!name) return;
    const project = projects.find((candidate) => candidate.id === sourceTask.projectId);
    if (!project) return;

    const now = Date.now();
    const forkedTask: Task = {
      id: `${now}`,
      projectId: sourceTask.projectId,
      name,
      prompt: "",
      agent: sourceTask.agent,
      permissionMode: sourceTask.permissionMode,
      model: sourceTask.model,
      reasoningEffort: sourceTask.reasoningEffort,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    setTasks((prev) => {
      const next = [forkedTask, ...prev];
      persistProjectTasks(forkedTask.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    setActiveProject(project);
    mountProject(project.id);
    updateProjectView(project.id, { selectedTaskId: forkedTask.id, isNewTask: false });
    tm.resetTaskTerminal(forkedTask.id);
    invokeForkTask(forkedTask, project, sourceSessionId ?? "");
  }

  async function handleReconnectTask(taskId: string) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const sessionId =
      task.agent === "codex"
        ? task.codexSessionId
        : task.agent === "dsh"
          ? task.dshSessionId
          : task.claudeSessionId;
    if (task.agent !== "dsh" && !sessionId) {
      showToast(t("running.resumeUnavailable"), "warning");
      return;
    }

    try {
      await invoke("reset_task_process", { taskId });
    } catch (e: unknown) {
      showToast(t("toast.resetTaskFailed", { error: String(e) }));
      return;
    }
    handleResumeTask(taskId);
  }

  function handleMarkTaskDone(taskId: string) {
    delete pendingResumeStartsRef.current[taskId];
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (isLiveTerminalTaskStatus(task.status)) {
      const project = projects.find((p) => p.id === task.projectId);
      const projectPath = task.worktreePath ?? project?.path ?? "";
      invoke("complete_task", { taskId, projectPath })
        .then(() => {
          tm.removeTaskBuffers([taskId]);
          scheduleForDoneTask(taskId);
        })
        .catch((e: unknown) => {
          showToast(t("toast.completeTaskFailed", { error: String(e) }));
        });
      return;
    }

    updateTaskStatus(taskId, "done");
    tm.removeTaskBuffers([taskId]);
    scheduleForDoneTask(taskId);
  }

  function cleanupTaskWorktree(task: Task, projectPath: string) {
    if (!task.worktreePath || !task.worktreeBranch || task.worktreeDiscarded) return;
    invoke("remove_task_worktree", {
      projectPath,
      repoPath: task.worktreeRepo ?? projectPath,
      worktreePath: task.worktreePath,
      branch: task.worktreeBranch,
    }).catch((e: unknown) => {
      showToast(t("toast.worktreeDiscardFailed", { error: String(e) }), "warning");
    });
  }

  function deleteTasks(taskIds: string[]) {
    if (taskIds.length === 0) return;

    setTasks((prev) => {
      const toDelete = new Set(taskIds);
      const deletingTasks = prev.filter((task) => toDelete.has(task.id));

      if (deletingTasks.length === 0) return prev;

      taskIds.forEach((taskId) => {
        delete pendingResumeStartsRef.current[taskId];
      });

      deletingTasks
        .filter((task) => isActiveTaskStatus(task.status))
        .forEach((task) => {
          const proj = projects.find((p) => p.id === task.projectId);
          const projectPath = task.worktreePath ?? proj?.path ?? "";
          invoke("cancel_task", { taskId: task.id, projectPath })
            .catch((e: unknown) => {
              showToast(t("toast.cancelTaskFailed", { error: String(e) }));
            })
            .finally(() => {
              if (proj) cleanupTaskWorktree(task, proj.path);
            });
        });

      deletingTasks
        .filter((task) => !isActiveTaskStatus(task.status))
        .forEach((task) => {
          const proj = projects.find((p) => p.id === task.projectId);
          if (proj) cleanupTaskWorktree(task, proj.path);
        });

      const next = prev.filter((task) => !toDelete.has(task.id));
      const affectedProjectIds = new Set(deletingTasks.map((t) => t.projectId));
      affectedProjectIds.forEach((pid) =>
        persistProjectTasks(pid, next, showToast, formatSaveTasksError),
      );
      return next;
    });

    tm.removeTaskBuffers(taskIds);
    setProjectViews((prev) => {
      const toDelete = new Set(taskIds);
      let changed = false;
      const next = { ...prev };

      for (const [projectId, view] of Object.entries(prev)) {
        if (view.selectedTaskId && toDelete.has(view.selectedTaskId)) {
          next[projectId] = { ...view, selectedTaskId: null, isNewTask: true };
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }

  async function handleDeleteTask(taskId: string) {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    const promptPreview = `${task.prompt.slice(0, 100)}${task.prompt.length > 100 ? "..." : ""}`;
    const ok = await confirm(t("task.deletePrompt", { prompt: promptPreview }), {
      title: t("task.deleteTitle"),
      kind: "warning",
    });
    if (!ok) return;
    deleteTasks([taskId]);
  }

  async function handleDeleteAllTasks(project: Project) {
    const projectTaskIds = tasks
      .filter((task) => task.projectId === project.id)
      .map((task) => task.id);
    if (projectTaskIds.length === 0) return;
    const ok = await confirm(
      t("task.clearPrompt", { count: projectTaskIds.length, project: project.name }),
      {
        title: t("task.clearTitle"),
        kind: "warning",
      },
    );
    if (!ok) return;
    deleteTasks(projectTaskIds);
  }

  function handleToggleTaskStar(taskId: string) {
    setTasks((prev) => {
      const task = prev.find((t) => t.id === taskId);
      if (!task) return prev;
      const next = prev.map((t) => (t.id === taskId ? { ...t, starred: !t.starred } : t));
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  /** 云效议题 → 待办任务：去重 + 写入任务 state 并落盘。 */
  async function handleImportYunxiaoIssue(
    issue: YunxiaoWorkitem,
    targetProjectId: string,
  ): Promise<boolean> {
    const targetProject = projects.find((p) => p.id === targetProjectId);
    if (!targetProject) return false;
    if (isYunxiaoWorkitemImported(tasks, issue.id)) return false;

    // Agent / 权限模式记忆：上次选择优先；无记忆时回退项目配置默认（再兜底 codex/ask）。
    const rememberedAgent = getLastYunxiaoAgent(targetProject.id);
    const rememberedPermission = getLastYunxiaoPermission(targetProject.id);
    let agent: AgentType = rememberedAgent ?? "codex";
    let permissionMode: PermissionMode = rememberedPermission ?? "ask";
    if (!rememberedAgent || !rememberedPermission) {
      try {
        const cfg = await invoke<{
          agent?: { default?: string; default_permission_mode?: string };
        }>("read_project_config", {
          projectPath: targetProject.path,
        });
        if (!rememberedAgent) {
          const cfgAgent = cfg.agent?.default;
          if (cfgAgent === "claude" || cfgAgent === "codex" || cfgAgent === "dsh") {
            agent = cfgAgent;
          }
        }
        if (!rememberedPermission) {
          const cfgPerm = cfg.agent?.default_permission_mode;
          if (cfgPerm === "ask" || cfgPerm === "auto_edit" || cfgPerm === "full_access") {
            permissionMode = cfgPerm;
          }
        }
      } catch {
        // 读取失败保持兜底，不阻断导入
      }
    }

    // 若最终选中的 Agent 已被禁用（应用级设置），回退到第一个启用的 Agent。
    try {
      const appSettings = await invoke<AgentEnabledState>("load_app_settings");
      if (!isAgentEnabled(appSettings, agent)) {
        agent = firstEnabledAgent(appSettings);
      }
    } catch {
      // 读取失败保持兜底，不阻断导入
    }

    const now = Date.now();
    const task: Task = {
      id: `${now}`,
      projectId: targetProject.id,
      name: buildYunxiaoTaskName(issue),
      prompt: buildYunxiaoPrompt(issue),
      agent,
      permissionMode,
      status: "todo",
      createdAt: now,
      updatedAt: now,
      yunxiaoWorkitemId: issue.id,
      yunxiaoSerialNumber: issue.serialNumber,
    };

    setTasks((prev) => {
      if (prev.some((t) => t.yunxiaoWorkitemId === issue.id)) return prev;
      const next = [task, ...prev];
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    return true;
  }

  function handleRenameTask(taskId: string, name: string) {
    setTasks((prev) => {
      const task = prev.find((t) => t.id === taskId);
      if (!task) return prev;
      const next = prev.map((t) => (t.id === taskId ? { ...t, name: name || undefined } : t));
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  async function handleGenerateTaskName(taskId: string) {
    const task = tasks.find((x) => x.id === taskId);
    if (!task) return;
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;
    // 按 agent 选择对应字段，避免历史数据两个字段都有时取错
    const sessionPath =
      task.agent === "codex" ? (task.codexSessionPath ?? null) : (task.claudeSessionPath ?? null);
    // 点击瞬间的快照，用于 await 完成后的并发校验（防止用户期间 rerun/resume/手改名）
    const expectedPriorName = task.name ?? "";
    const expectedPrompt = task.prompt;
    const expectedStatus = task.status;
    const expectedSessionPath = sessionPath;
    try {
      const name = await invoke<string>("generate_task_name", {
        projectPath: project.path,
        agent: task.agent,
        sessionPath,
        originalPrompt: task.prompt,
      });
      const trimmed = name.trim();
      if (!trimmed) return;

      // await 期间用户可能删除任务、改名、重跑、resume 进新 session → 在同一个
      // setTasks updater 内完成校验和写入，避免依赖 React 对 updater 的同步调度。
      setTasks((prev) => {
        const current = prev.find((x) => x.id === taskId);
        if (!current) return prev;
        if ((current.name ?? "") !== expectedPriorName) return prev;
        if (current.prompt !== expectedPrompt) return prev;
        if (current.status !== expectedStatus) return prev;
        const currentSessionPath =
          current.agent === "codex"
            ? (current.codexSessionPath ?? null)
            : (current.claudeSessionPath ?? null);
        if (currentSessionPath !== expectedSessionPath) return prev;

        const next = prev.map((x) => (x.id === taskId ? { ...x, name: trimmed || undefined } : x));
        persistProjectTasks(current.projectId, next, showToast, formatSaveTasksError);
        return next;
      });
    } catch (e) {
      showToast(t("task.generateNameFailed", { error: String(e) }), "error");
      throw e;
    }
  }

  function handleUpdateTodo(
    taskId: string,
    updates: { prompt: string; agent: AgentType; permissionMode: PermissionMode },
  ) {
    setTasks((prev) => {
      const task = prev.find((t) => t.id === taskId);
      if (!task || task.status !== "todo") return prev;
      const next = prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              ...updates,
              model: updates.agent === t.agent ? t.model : undefined,
              reasoningEffort: updates.agent === t.agent ? t.reasoningEffort : undefined,
            }
          : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  /** 云效详情页「定稿」：把补全后的议题内容写回待办 prompt。 */
  function handleFinalizeYunxiaoTodo(
    taskId: string,
    prompt: string,
    supplement: YunxiaoSupplement,
  ) {
    setTasks((prev) => {
      const task = prev.find((t) => t.id === taskId);
      if (!task || task.status !== "todo") return prev;
      const next = prev.map((t) =>
        t.id === taskId ? { ...t, prompt, yunxiaoSupplement: supplement } : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  /** 云效详情页「草稿」：AI 预填/编辑后防抖落盘，切走再回来（组件重挂载）时恢复；
   *  finalized 保持 false，直到用户显式定稿。 */
  function handleYunxiaoDraftChange(taskId: string, fields: Record<string, string>) {
    setTasks((prev) => {
      const task = prev.find((t) => t.id === taskId);
      if (!task || task.status !== "todo") return prev;
      const next = prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              yunxiaoSupplement: {
                fields,
                originalPrompt: t.yunxiaoSupplement?.originalPrompt ?? t.prompt,
                finalized: false,
              },
            }
          : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
  }

  /** 云效详情页「发起讨论」：先落定稿 prompt + 所选 Agent，再复用 run 链路启动会话。 */
  function handleStartYunxiaoDiscussion(
    taskId: string,
    prompt: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const project = projects.find((p) => p.id === task.projectId);
    if (!project) return;
    setTasks((prev) => {
      const next = prev.map((t) =>
        t.id === taskId
          ? {
              ...t,
              prompt,
              agent,
              permissionMode,
              model: agent === t.agent ? t.model : undefined,
              reasoningEffort: agent === t.agent ? t.reasoningEffort : undefined,
            }
          : t,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    handleRunTodoTask({ ...task, prompt, agent, permissionMode });
  }

  /** 生成云效回写草稿（开发向 + 测试向）：优先读取会话中落盘的讨论草稿，无草稿时 headless 生成。 */
  async function handleGenerateYunxiaoWritebackSummary(
    taskId: string,
    force = false,
  ): Promise<YunxiaoWritebackDraft> {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task not found");
    const project = projects.find((candidate) => candidate.id === task.projectId);
    if (!project) throw new Error("Project not found");
    const fieldsText = buildYunxiaoFieldsText(task.yunxiaoSupplement?.fields);
    const worktreeAlive = !!task.worktreePath && !task.worktreeDiscarded;
    const sessionPath =
      task.agent === "codex"
        ? task.codexSessionPath
        : task.agent === "claude"
          ? task.claudeSessionPath
          : undefined;
    return invoke<YunxiaoWritebackDraft>("generate_yunxiao_writeback_summary", {
      projectPath: project.path,
      taskId,
      repoPath: worktreeAlive ? task.worktreePath : (task.worktreeRepo ?? project.path),
      serialNumber: task.yunxiaoSerialNumber ?? "",
      taskName: task.name ?? task.prompt.slice(0, 80),
      fieldsText,
      sessionPath,
      baseBranch: task.baseBranch,
      // DSH 任务回退用 claude headless 生成汇总（与议题预填一致）
      agent: task.agent === "codex" ? "codex" : "claude",
      force,
    });
  }

  /**
   * 提交总结回写云效议题：发布开发向 + 测试向两条评论，再把「价值评分」写入议题字段。
   * 返回回写结果（字段写入状态与警告），成功后记录幂等标记。
   */
  async function handleWritebackYunxiao(
    taskId: string,
    devContent: string,
    testContent: string,
  ): Promise<YunxiaoWritebackResult> {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !task.yunxiaoWorkitemId) throw new Error("Not a Yunxiao task");
    const project = projects.find((candidate) => candidate.id === task.projectId);
    if (!project) throw new Error("Project not found");
    const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
    const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    if (!yunxiao.token || !yunxiao.organizationId) {
      throw new Error(t("yunxiao.notConnected"));
    }
    const result = await invoke<YunxiaoWritebackResult>("yunxiao_writeback_with_score", {
      token: yunxiao.token,
      organizationId: yunxiao.organizationId,
      workitemId: task.yunxiaoWorkitemId,
      devContent,
      testContent,
    });
    const now = Date.now();
    setTasks((prev) => {
      const next = prev.map((candidate) =>
        candidate.id === taskId
          ? {
              ...candidate,
              yunxiaoWrittenBackAt: now,
              yunxiaoCommentId: result.devCommentId,
            }
          : candidate,
      );
      persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      return next;
    });
    return result;
  }

  /** 补写云效议题「价值评分」字段（评论已发布但字段写入失败时的重试入口，不重复发评论）。 */
  async function handleRetryWritebackScoreField(
    taskId: string,
    value: number,
  ): Promise<void> {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !task.yunxiaoWorkitemId) throw new Error("Not a Yunxiao task");
    const project = projects.find((candidate) => candidate.id === task.projectId);
    if (!project) throw new Error("Project not found");
    const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
    const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    if (!yunxiao.token || !yunxiao.organizationId) {
      throw new Error(t("yunxiao.notConnected"));
    }
    await invoke("yunxiao_write_score_field", {
      token: yunxiao.token,
      organizationId: yunxiao.organizationId,
      workitemId: task.yunxiaoWorkitemId,
      value,
    });
  }

  /** 生成知识沉淀候选：优先读取会话收尾时落盘的知识草稿，无草稿时内置规则 headless 提取。 */
  async function handleGenerateKnowledgeSedimentation(
    taskId: string,
    force = false,
  ): Promise<KnowledgeSuggestion[]> {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error("Task not found");
    const project = projects.find((candidate) => candidate.id === task.projectId);
    if (!project) throw new Error("Project not found");
    const fieldsText = buildYunxiaoFieldsText(task.yunxiaoSupplement?.fields);
    const sessionPath =
      task.agent === "codex"
        ? task.codexSessionPath
        : task.agent === "claude"
          ? task.claudeSessionPath
          : undefined;
    const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
    const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    const link =
      yunxiao.projectId && task.yunxiaoWorkitemId
        ? buildYunxiaoIssueLink(yunxiao.projectId, task.yunxiaoWorkitemId)
        : "";
    return invoke<KnowledgeSuggestion[]>("generate_knowledge_sedimentation", {
      projectPath: project.path,
      taskId,
      serialNumber: task.yunxiaoSerialNumber ?? "",
      taskName: task.name ?? task.prompt.slice(0, 80),
      fieldsText,
      link,
      sessionPath,
      agent: task.agent === "codex" ? "codex" : "claude",
      force,
    });
  }

  /** 批量创建知识沉淀审核议题（去重命中不重复建），返回新创建/去重命中的议题 ID。 */
  async function handleCreateKnowledgeIssues(
    taskId: string,
    suggestions: KnowledgeSuggestion[],
  ): Promise<string[]> {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task || !task.yunxiaoWorkitemId) throw new Error("Not a Yunxiao task");
    const project = projects.find((candidate) => candidate.id === task.projectId);
    if (!project) throw new Error("Project not found");
    const appSettings = await invoke<{
      yunxiao?: YunxiaoSettings;
      knowledge?: KnowledgeSettings;
    }>("load_app_settings");
    const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    const autoWriteback = appSettings.knowledge?.autoWriteback ?? false;
    if (!yunxiao.token || !yunxiao.organizationId) {
      throw new Error(t("yunxiao.notConnected"));
    }
    const kbProjectId =
      yunxiao.knowledgeBaseProjectId ?? YUNXIAO_KNOWLEDGE_BASE_PROJECT_ID;
    const link =
      yunxiao.projectId && task.yunxiaoWorkitemId
        ? buildYunxiaoIssueLink(yunxiao.projectId, task.yunxiaoWorkitemId)
        : "";
    // 一次提交合并成一条云效知识议题（所有候选进同一描述，不再每条一个议题）。
    const serial = task.yunxiaoSerialNumber ?? "";
    const taskLabel = (task.name ?? task.prompt).slice(0, 60);
    const graphLabel = suggestions[0]?.knowledgeGraphId ?? "未绑定";
    const title = `【知识沉淀】【${graphLabel}】${serial ? `${serial} ` : ""}${taskLabel}（${suggestions.length} 条）`;
    const candidateSections = suggestions
      .map(
        (s, i) =>
          [
            `### ${i + 1}. ${s.module} / ${s.section}`,
            `目标模块卡片：${s.module}（data/modules/${s.module}.md）`,
            `目标知识库：${s.knowledgeGraphId || "未绑定"}`,
            "",
            s.content,
            "",
            `依据：${s.evidence}`,
            `置信度：${s.confidence === "confirmed" ? "已确认" : "待验证"}`,
          ].join("\n"),
      )
      .join("\n\n");
    const description = [
      `来源议题：${serial} ${link}`,
      `候选数量：${suggestions.length}`,
      "",
      candidateSections,
      "",
      autoWriteback
        ? "自动回写已开启：质量门通过的条目将自动写入模块卡片并 git 提交推送；全部通过时本议题自动置为已完成，未通过条目保留人工审核。"
        : "审核指引：审核通过后由知识库负责人更新对应 data/modules/<module>.md 并提交（git 统一管理）。",
    ].join("\n");
    const result = await invoke<CreateKnowledgeIssueResult>(
      "yunxiao_create_knowledge_issue",
      {
        token: yunxiao.token,
        organizationId: yunxiao.organizationId,
        projectId: kbProjectId,
        subject: title,
        description,
      },
    );
    const createdIds = result.created ? [result.workitemId] : [];
    if (createdIds.length > 0) {
      setTasks((prev) => {
        const next = prev.map((candidate) =>
          candidate.id === taskId
            ? {
                ...candidate,
                knowledgeIssueIds: [
                  ...(candidate.knowledgeIssueIds ?? []),
                  ...createdIds,
                ],
              }
            : candidate,
        );
        persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
        return next;
      });
    }
    // 自动回写：仅在新建议题时执行一次（duplicated 命中说明此前已提交过，幂等跳过）。
    if (autoWriteback && result.created) {
      const agent = task.agent === "codex" ? "codex" : "claude";
      try {
        const writeback = await invoke<KnowledgeWritebackResult>(
          "knowledge_auto_writeback",
          { projectPath: project.path, suggestions, agent },
        );
        if (writeback.allPassed && writeback.writtenCount > 0) {
          await invoke("yunxiao_complete_workitem", {
            token: yunxiao.token,
            organizationId: yunxiao.organizationId,
            workitemId: result.workitemId,
          });
          showToast(
            `知识已自动写入技能库（${writeback.writtenCount} 条）并推送，议题已置为已完成`,
            "success",
          );
        } else {
          const writtenLines = writeback.items
            .filter((item) => item.written)
            .map((item) => `- ${item.module} / ${item.section}：已自动写入模块卡片`);
          const failedLines = writeback.items
            .filter((item) => !item.passed)
            .map((item) => `- ${item.module} / ${item.section}：${item.reason || "质量门未通过"}`);
          const comment = [
            `自动回写结果：通过 ${writeback.writtenCount} / 共 ${suggestions.length} 条。`,
            "",
            ...(writtenLines.length > 0 ? ["已自动写入：", ...writtenLines, ""] : []),
            ...(failedLines.length > 0 ? ["待人工审核：", ...failedLines] : []),
          ].join("\n");
          await invoke("yunxiao_create_workitem_comment", {
            token: yunxiao.token,
            organizationId: yunxiao.organizationId,
            workitemId: result.workitemId,
            content: comment,
          }).catch(() => {});
          showToast(
            `质量门通过 ${writeback.writtenCount}/${suggestions.length} 条，未通过条目保留人工审核`,
            "warning",
          );
        }
      } catch (e) {
        showToast(`知识自动回写失败：${String(e)}（议题保留人工审核）`, "error");
      }
    }
    return createdIds;
  }

  /** 消费一份已读到的补录议题草稿：建云效议题 Y + 绑定待办任务，并按草稿实际目录清草稿（幂等）。 */
  async function processBackfillDraft(
    sourceTask: Task,
    draft: BackfillIssueRequest,
    draftTaskId: string,
    effectivePath: string,
  ): Promise<void> {
    // 检出草稿后才读云效设置（避免每个活跃任务反复 invoke）。
    const appSettings = await invoke<{ yunxiao?: YunxiaoSettings }>("load_app_settings");
    const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
    if (!yunxiao.token || !yunxiao.organizationId || !yunxiao.projectId) return;

    const signature = deriveBackfillSignature(sourceTask, draft);
    // 幂等：若同一来源+内容签名已创建过，则只清掉重新出现的草稿，不再重复建议题。
    const consumed = await invoke<{ signature: string; workitemId: string } | null>(
      "read_backfill_consumed",
      { projectPath: effectivePath, taskId: draftTaskId },
    ).catch(() => null);
    if (consumed && consumed.signature === signature) {
      await invoke("clear_backfill_draft", {
        projectPath: effectivePath,
        taskId: draftTaskId,
      }).catch(() => {});
      return;
    }

    try {
      const created = await invoke<{
        created: boolean;
        workitemId: string;
        serialNumber?: string;
      }>("yunxiao_create_backfill_issue", {
        token: yunxiao.token,
        organizationId: yunxiao.organizationId,
        projectId: yunxiao.projectId,
        request: draft,
      });
      if (!created.created) return;
      // 记录消费标记（幂等），即使 Agent 之后重复写入同一内容也不会再建。
      await invoke("write_backfill_consumed", {
        projectPath: effectivePath,
        taskId: draftTaskId,
        signature,
        workitemId: created.workitemId,
      }).catch(() => {});

      const now = Date.now();
      const name = `${created.serialNumber ? `${created.serialNumber} ` : ""}${draft.subject}`.trim();
      const bodyLines = draft.contentSections
        .filter((s) => s.text.trim())
        .map((s) => `${s.label}：${s.text.trim()}`);
      const prompt = [
        draft.subject,
        ...bodyLines,
        "---",
        `云效议题：${created.serialNumber ?? ""}`,
        `来源任务：${sourceTask.name ?? sourceTask.prompt.slice(0, 80)}`,
        `来源议题 ID：${sourceTask.yunxiaoWorkitemId ?? ""}`,
        `议题 ID：${created.workitemId}`,
      ].join("\n");
      const task: Task = {
        id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
        projectId: sourceTask.projectId,
        name,
        prompt,
        agent: sourceTask.agent,
        permissionMode: sourceTask.permissionMode,
        status: "todo",
        createdAt: now,
        updatedAt: now,
        yunxiaoWorkitemId: created.workitemId,
        yunxiaoSerialNumber: created.serialNumber,
        derivedFromTaskId: sourceTask.id,
        derivedFromWorkitemId: sourceTask.yunxiaoWorkitemId,
      };
      let added = false;
      setTasks((prev) => {
        if (prev.some((candidate) => candidate.yunxiaoWorkitemId === created.workitemId)) {
          return prev;
        }
        added = true;
        const next = [task, ...prev];
        persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
        return next;
      });
      await invoke("clear_backfill_draft", {
        projectPath: effectivePath,
        taskId: draftTaskId,
      }).catch(() => {});
      if (added) {
        showToast("已补录云效议题并生成绑定待办");
      }
    } catch {
      // 创建失败/网络错误：保留草稿，后续轮询重试
    }
  }

  /** 云效任务运行中轮询补录议题草稿：按「有效路径（worktree ?? 项目根）」扫描 backfill-issue.json，检出即建 Y + 待办。 */
  async function handleScanBackfillDrafts(): Promise<void> {
    const current = tasksRef.current;
    // 按有效路径分组活跃任务，便于定位草稿实际落盘位置（工作树或项目根）。
    const byEffectivePath = new Map<string, Task[]>();
    for (const t of current) {
      if (!isActiveTaskStatus(t.status)) continue;
      const project = projects.find((p) => p.id === t.projectId);
      if (!project) continue;
      const eff = t.worktreePath ?? project.path;
      const arr = byEffectivePath.get(eff) ?? [];
      arr.push(t);
      byEffectivePath.set(eff, arr);
    }
    for (const [effectivePath, activeTasks] of byEffectivePath) {
      const entries = await invoke<BackfillDraftEntry[]>("list_backfill_drafts", {
        projectPath: effectivePath,
      }).catch(() => []);
      for (const entry of entries) {
        // 匹配来源任务：目录名 == 活跃任务 id；否则项目内唯一活跃任务回落（覆盖 Agent 自造目录名）。
        let sourceTask = activeTasks.find((t) => t.id === entry.taskId);
        if (!sourceTask && activeTasks.length === 1) sourceTask = activeTasks[0];
        if (!sourceTask) {
          console.warn(`[backfill] 无法匹配补录草稿到活跃任务：${entry.taskId} @ ${effectivePath}`);
          continue;
        }
        const key = `${effectivePath}:${entry.taskId}`;
        if (backfillProcessingRef.current.has(key)) continue;
        backfillProcessingRef.current.add(key);
        processBackfillDraft(sourceTask, entry.request, entry.taskId, effectivePath)
          .catch(() => {})
          .finally(() => backfillProcessingRef.current.delete(key));
      }
    }
  }

  // 云效任务运行中轮询补录议题草稿：检出即建 Y + 待办（近实时，不依赖任务收尾）。
  useEffect(() => {
    const BACKFILL_POLL_MS = 4000;
    const id = window.setInterval(() => {
      const handler = backfillHandlerRef.current;
      if (!handler) return;
      handler()
        .catch(() => {});
    }, BACKFILL_POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  async function handleDeleteProject(projectId: string) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;
    const ok = await confirm(t("task.deleteProjectPrompt", { project: project.name }), {
      title: t("task.deleteProjectTitle"),
      kind: "warning",
    });
    if (!ok) return;
    const projectTaskIds = tasks.filter((t) => t.projectId === projectId).map((t) => t.id);
    deleteTasks(projectTaskIds);
    invoke<number>("cleanup_installations_for_project", { projectId }).catch((e) =>
      console.error("cleanup_installations_for_project failed", e),
    );
    setProjects((prev) => {
      const next = prev.filter((p) => p.id !== projectId);
      persistProjects(next, showToast, formatSaveProjectsError);
      return next;
    });
    setMountedProjectIds((prev) => prev.filter((id) => id !== projectId));
    clearProjectView(projectId);
    setActiveProject((prev) => {
      if (prev?.id === projectId) {
        return null;
      }
      return prev;
    });
  }

  function handleToggleProjectHidden(projectId: string) {
    setProjects((prev) => {
      const next = prev.map((p) =>
        p.id === projectId ? { ...p, hiddenFromRail: !p.hiddenFromRail } : p,
      );
      persistProjects(next, showToast, formatSaveProjectsError);
      return next;
    });
  }

  async function handleRenameProject(
    projectId: string,
    rawName: string,
  ): Promise<ProjectRenameResult> {
    const normalizedName = normalizeProjectNameInput(rawName);
    const current = projects.find((project) => project.id === projectId);
    if (current?.name === normalizedName) return { ok: true, name: current.name };

    const renameableProjects = projects.filter(
      (project) => project.id !== skillHubConfig?.hubProjectId,
    );
    const result = validateProjectName(rawName, renameableProjects, projectId);
    if (!result.ok) return result;

    const next = projects.map((project) =>
      project.id === projectId ? { ...project, name: result.name } : project,
    );
    const saved = await persistProjects(next, showToast, formatSaveProjectsError);
    if (!saved) return { ok: false, error: "save_failed" };

    setProjects((prev) =>
      prev.map((project) =>
        project.id === projectId ? { ...project, name: result.name } : project,
      ),
    );

    return result;
  }

  // 拖拽结束时一次性提交新顺序;beforeId === null 表示拖到 visible 末尾。
  // visibleIds 来自 ProjectRail 内部过滤后的 railProjects(去 hiddenFromRail/hub),
  // src/dst 必须在这个子集里算,否则会无声打乱隐藏项的相对位置。
  // 拖拽期间 ProjectRail 内部只用 transform 让位,不会调到这里,避免高频重渲染和写盘。
  const handleCommitProjectOrder = useCallback(
    (draggedId: string, beforeId: string | null, visibleIds: string[]) => {
      setProjects((prev) => {
        const next = reorderProjects(prev, visibleIds, draggedId, beforeId);
        if (next === prev) return prev;
        persistProjects(next, showToast, formatSaveProjectsError);
        return next;
      });
    },
    [showToast, formatSaveProjectsError],
  );

  function updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    extra?: Pick<Task, "attentionRequestedAt">,
    failureReason?: string,
  ) {
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((task) => {
        if (task.id !== taskId) return task;
        if (shouldIgnoreTaskStatusTransition(task.status, status)) return task;

        const attentionRequestedAt =
          status === "input_required" || status === "awaiting_review"
            ? (extra?.attentionRequestedAt ?? Date.now())
            : undefined;

        if (task.status === status && task.attentionRequestedAt === attentionRequestedAt) {
          return task;
        }

        changed = true;
        const updated: Task = { ...task, status, attentionRequestedAt, updatedAt: Date.now() };
        if (status === "failed" && failureReason) updated.failureReason = failureReason;
        return updated;
      });

      if (changed) {
        const task = next.find((t) => t.id === taskId);
        if (task) persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      }
      return changed ? next : prev;
    });
  }

  function updateTaskSession(taskId: string, sessionId: string, sessionPath: string) {
    setTasks((prev) => {
      let changed = false;
      const next = prev.map((task) => {
        if (task.id !== taskId) return task;
        if (task.agent === "claude") {
          if (task.claudeSessionId === sessionId && task.claudeSessionPath === sessionPath)
            return task;
          changed = true;
          return { ...task, claudeSessionId: sessionId, claudeSessionPath: sessionPath };
        } else if (task.agent === "dsh") {
          if (task.dshSessionId === sessionId && task.dshSessionPath === sessionPath)
            return task;
          changed = true;
          return { ...task, dshSessionId: sessionId, dshSessionPath: sessionPath };
        } else {
          if (task.codexSessionId === sessionId && task.codexSessionPath === sessionPath)
            return task;
          changed = true;
          return { ...task, codexSessionId: sessionId, codexSessionPath: sessionPath };
        }
      });

      if (changed) {
        const task = next.find((t) => t.id === taskId);
        if (task) persistProjectTasks(task.projectId, next, showToast, formatSaveTasksError);
      }
      return changed ? next : prev;
    });
  }

  function handleTerminalReady(taskId: string, generation: number) {
    tm.handleTerminalReady(taskId, generation);
    const startResume = pendingResumeStartsRef.current[taskId];
    if (!startResume) return;
    delete pendingResumeStartsRef.current[taskId];
    startResume();
  }

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [projects],
  );
  // rail 顺序直接由 projects 数组承载;拖拽通过 handleCommitProjectOrder 改变这个数组。
  // 老版本在这里 sort 是为了给 backend 写入的"任意"顺序提供一个稳定视觉,
  // 现在改由 init 时一次性迁移 + 用户拖拽决定。
  const railProjects = projects;
  const mountedProjects = useMemo(
    () =>
      mountedProjectIds
        .map((id) => projects.find((project) => project.id === id))
        .filter((project): project is Project => !!project),
    [mountedProjectIds, projects],
  );
  const hubProjectId = skillHubConfig?.hubProjectId;
  const visibleProjectsForWelcome = useMemo(
    () => sortedProjects.filter((p) => p.id !== hubProjectId),
    [sortedProjects, hubProjectId],
  );

  const handleEnterSkillHub = useCallback(() => {
    if (!hubProjectId) return;
    const hub = projects.find((p) => p.id === hubProjectId);
    if (!hub) return;
    const updated = { ...hub, lastOpenedAt: Date.now() };
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === hub.id ? updated : p));
      persistProjects(next, showToast, formatSaveProjectsError);
      return next;
    });
    setHubMode(true);
    setActiveProject(updated);
    mountProject(updated.id);
    invoke("init_project_config", { projectPath: updated.path }).catch((e: unknown) => {
      showToast(t("toast.initProjectConfigFailed", { error: String(e) }), "warning");
    });
  }, [hubProjectId, projects, mountProject, showToast, formatSaveProjectsError, t]);

  const handleExitSkillHub = useCallback(() => {
    setHubMode(false);
    setActiveProject(null);
  }, []);

  // 看板入口在 ProjectRail 底部触发,打开全屏浮层覆盖当前页面。
  // 不切换 activeProject,关闭浮层后用户回到原先所在的任务上下文。
  useEffect(() => {
    const handle = () => setShowKanban(true);
    window.addEventListener(OPEN_KANBAN_VIEW_EVENT, handle);
    return () => window.removeEventListener(OPEN_KANBAN_VIEW_EVENT, handle);
  }, []);

  // 从看板跳转到某个项目（可选定位到具体 task）。关浮层 + 切活动项目（或进入 hub）
  // + 在该项目的本地视图状态里选中 task。三步必须一起做,任何一步漏掉都会让用户看到
  // 错位的页面状态。
  function enterProjectFromKanban(project: Project, taskId?: string) {
    setShowKanban(false);
    if (project.id === hubProjectId) {
      handleEnterSkillHub();
    } else {
      handleProjectClick(project);
    }
    if (taskId) {
      updateProjectView(project.id, { selectedTaskId: taskId, isNewTask: false });
    }
  }

  return (
    <div style={s.rootRelative}>
      <div style={s.appProjectLayer}>
        {mountedProjects.map((project) => {
          const view = getProjectView(project.id);
          const isHubActive = hubMode && project.id === hubProjectId;
          const railProjectsFiltered = isHubActive
            ? [project]
            : railProjects.filter((p) => p.id !== hubProjectId);
          const otherProjectsFiltered = isHubActive
            ? []
            : sortedProjects.filter((p) => p.id !== project.id && p.id !== hubProjectId);
          return (
            <ProjectPage
              key={project.id}
              project={project}
              visible={activeProject?.id === project.id}
              allProjects={railProjectsFiltered}
              otherProjects={otherProjectsFiltered}
              hubMode={isHubActive}
              onExitSkillHub={handleExitSkillHub}
              tasks={tasks}
              getTaskRestoreState={tm.getTaskRestoreState}
              taskRunCounts={taskRunCounts}
              selectedTaskId={view.selectedTaskId}
              isNewTask={view.isNewTask}
              onNewTask={() =>
                updateProjectView(project.id, { selectedTaskId: null, isNewTask: true })
              }
              onSelectTask={(id) =>
                updateProjectView(project.id, { selectedTaskId: id, isNewTask: false })
              }
              onDeleteTask={handleDeleteTask}
              onDeleteAllTasks={() => handleDeleteAllTasks(project)}
              onToggleTaskStar={handleToggleTaskStar}
              onRenameTask={handleRenameTask}
              onGenerateTaskName={handleGenerateTaskName}
              onSubmitTask={(taskInput) => handleSubmitTask(project, taskInput)}
              onRunTodoTask={handleRunTodoTask}
              onUpdateTodo={handleUpdateTodo}
              onFinalizeYunxiaoTodo={handleFinalizeYunxiaoTodo}
              onYunxiaoDraftChange={handleYunxiaoDraftChange}
              onStartYunxiaoDiscussion={handleStartYunxiaoDiscussion}
              onGenerateWritebackSummary={handleGenerateYunxiaoWritebackSummary}
              onWritebackYunxiao={handleWritebackYunxiao}
              onRetryWritebackScoreField={handleRetryWritebackScoreField}
              onGenerateKnowledgeSedimentation={handleGenerateKnowledgeSedimentation}
              onCreateKnowledgeIssues={handleCreateKnowledgeIssues}
              onCancelTask={handleCancelTask}
              onResumeTask={handleResumeTask}
              onResumeTaskAndSend={handleResumeTaskAndSend}
              onForkTask={handleForkTask}
              onMergeWorktree={handleMergeWorktree}
              onDiscardWorktree={handleDiscardWorktree}
              onReconnectTask={handleReconnectTask}
              onMarkTaskDone={handleMarkTaskDone}
              onInput={tm.handleInput}
              onResize={tm.handleResize}
              onRegisterTerminal={tm.handleRegisterTerminal}
              onTerminalReady={handleTerminalReady}
              onSnapshot={tm.handleSnapshot}
              onBack={handleBack}
              onSwitchProject={handleProjectClick}
              onCommitProjectOrder={handleCommitProjectOrder}
              onOpen={handleOpen}
              themeVariant={themeVariant}
              themeMode={themeMode}
              systemPrefersDark={systemPrefersDark}
              onThemeModeChange={handleThemeModeChange}
              onToggleTheme={handleToggleTheme}
              terminalFontSize={terminalFontSize}
              onTerminalFontSizeChange={setTerminalFontSize}
              taskDisplayWindow={taskDisplayWindow}
              onTaskDisplayWindowChange={setTaskDisplayWindow}
              attentionBadge={attentionBadge}
              onAttentionBadgeChange={setAttentionBadge}
              terminalScrollback={terminalScrollback}
              onTerminalScrollbackChange={handleTerminalScrollbackChange}
              uiFontFamily={uiFontFamily}
              onUiFontFamilyChange={setUiFontFamily}
              monoFontFamily={monoFontFamily}
              onMonoFontFamilyChange={setMonoFontFamily}
            />
          );
        })}
      </div>
      {showKanban && (
        <div style={s.kanbanOverlay}>
          <KanbanView
            projects={sortedProjects}
            tasks={tasks}
            onClose={() => setShowKanban(false)}
            onTaskClick={(task) => {
              const project = projects.find((p) => p.id === task.projectId);
              if (project) enterProjectFromKanban(project, task.id);
            }}
            onProjectClick={(project) => enterProjectFromKanban(project)}
          />
        </div>
      )}
      {!activeProject && (
        <div style={s.appWelcomeLayer}>
          <WelcomePage
            projects={visibleProjectsForWelcome}
            allProjects={sortedProjects}
            tasks={tasks}
            onOpen={handleOpen}
            onProjectClick={handleProjectClick}
            onStartCodeupTask={startCodeupTask}
            onDeleteProject={handleDeleteProject}
            onToggleProjectHidden={handleToggleProjectHidden}
            onRenameProject={handleRenameProject}
            skillHubConfig={skillHubConfig}
            onEnterSkillHub={handleEnterSkillHub}
            onImportYunxiaoIssue={handleImportYunxiaoIssue}
            themeVariant={themeVariant}
            themeMode={themeMode}
            systemPrefersDark={systemPrefersDark}
            onThemeModeChange={handleThemeModeChange}
            onToggleTheme={handleToggleTheme}
            terminalFontSize={terminalFontSize}
            onTerminalFontSizeChange={setTerminalFontSize}
            taskDisplayWindow={taskDisplayWindow}
            onTaskDisplayWindowChange={setTaskDisplayWindow}
            attentionBadge={attentionBadge}
            onAttentionBadgeChange={setAttentionBadge}
            terminalScrollback={terminalScrollback}
            onTerminalScrollbackChange={handleTerminalScrollbackChange}
            uiFontFamily={uiFontFamily}
            onUiFontFamilyChange={setUiFontFamily}
            monoFontFamily={monoFontFamily}
            onMonoFontFamilyChange={setMonoFontFamily}
          />
        </div>
      )}
    </div>
  );
}

export default App;
