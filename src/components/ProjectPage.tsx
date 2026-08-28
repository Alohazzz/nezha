import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  Task,
  BranchBatch,
  AgentType,
  PermissionMode,
  TaskStatus,
  YunxiaoSupplement,
  ThemeMode,
  ThemeVariant,
  TerminalFontSize,
  TerminalScrollback,
  TaskDisplayWindow,
  FontFamily,
  KnowledgeSuggestion,
  YunxiaoWritebackResult,
} from "../types";
import { TaskPanel } from "./TaskPanel";
import { NewTaskView, type NewTaskDraft } from "./NewTaskView";
import { RunningView } from "./RunningView";
import { FileExplorer } from "./FileExplorer";
import { FileSearchDialog } from "./file-explorer/SearchPanel";
import { FileViewer } from "./FileViewer";
import { CommentSendDialog, type SendMode } from "./file-viewer/CommentSendDialog";
import {
  buildBatchMessage,
  newCommentId,
  resolveTargetTask,
  type CommentDraft,
  type ReviewComment,
} from "./file-viewer/reviewComments";
import {
  type DiffCommentDraft,
  type DiffReviewComment,
} from "./git-diff/diffReview";
import { GitChanges } from "./GitChanges";
import { GitHistory } from "./GitHistory";
import { BuildPanel } from "./build/BuildPanel";
import { GitDiffViewer } from "./GitDiffViewer";
import { ProjectRail } from "./ProjectRail";
import { SettingsDialog } from "./SettingsDialog";
import { RightToolbar } from "./RightToolbar";
import { BranchBatchView } from "./branch-batch/BranchBatchView";
import { WorktreeScopeSelect } from "./branch-batch/WorktreeScopeSelect";
import { TodoTaskView } from "./TodoTaskView";
import { YunxiaoIssueDetailView } from "./yunxiao/YunxiaoIssueDetailView";
import { YunxiaoWritebackDialog } from "./yunxiao/YunxiaoWritebackDialog";
import { KnowledgeSedimentationDialog } from "./yunxiao/KnowledgeSedimentationDialog";
import { issueTag, splitValueScoreSection } from "../utils/yunxiao";
import { ShellTerminalPanel, type ShellTerminalPanelHandle } from "./ShellTerminalPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { useToast } from "./Toast";
import { useProjectPanels } from "../hooks/useProjectPanels";
import { resolveProjectGitContext, useGitRoots } from "../hooks/useGitRoots";
import { useI18n } from "../i18n";

/** 发送目标兜底：存活任务自动判定 → 全死时最近任务（让「恢复会话/新建」入口可达） */
function fallbackTarget(tasks: Task[]): Task | null {
  return (
    resolveTargetTask(tasks) ??
    [...tasks].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0] ??
    null
  );
}
import s from "../styles";

export function ProjectPage({
  project,
  visible = true,
  allProjects = [],
  otherProjects = [],
  tasks,
  getTaskRestoreState,
  taskRunCounts,
  selectedTaskId,
  isNewTask,
  onNewTask,
  onSelectTask,
  onDeleteTask,
  onDeleteAllTasks,
  onToggleTaskStar,
  onRenameTask,
  onGenerateTaskName,
  onSubmitTask,
  onRunTodoTask,
  onUpdateTodo,
  onFinalizeYunxiaoTodo,
  onYunxiaoDraftChange,
  onStartYunxiaoDiscussion,
  onGenerateWritebackSummary,
  onWritebackYunxiao,
  onRetryWritebackScoreField,
  onGenerateKnowledgeSedimentation,
  onCreateKnowledgeIssues,
  onCancelTask,
  onResumeTask,
  onResumeTaskAndSend,
  onForkTask,
  onMergeWorktree,
  onDiscardWorktree,
  onReconnectTask,
  onMarkTaskDone,
  onInput,
  onResize,
  onRegisterTerminal,
  onTerminalReady,
  onSnapshot,
  onBack,
  onSwitchProject,
  onCommitProjectOrder,
  onOpen,
  themeVariant,
  themeMode,
  systemPrefersDark,
  onThemeModeChange,
  onToggleTheme,
  terminalFontSize,
  onTerminalFontSizeChange,
  taskDisplayWindow,
  onTaskDisplayWindowChange,
  attentionBadge,
  onAttentionBadgeChange,
  terminalScrollback,
  onTerminalScrollbackChange,
  uiFontFamily,
  onUiFontFamilyChange,
  monoFontFamily,
  onMonoFontFamilyChange,
  hubMode = false,
  onExitSkillHub,
}: {
  project: Project;
  visible?: boolean;
  allProjects?: Project[];
  otherProjects?: Project[];
  tasks: Task[];
  getTaskRestoreState: (taskId: string) => { initialData?: string; initialSnapshot?: string };
  taskRunCounts: Record<string, number>;
  selectedTaskId: string | null;
  isNewTask: boolean;
  onNewTask: () => void;
  onSelectTask: (id: string) => void;
  onDeleteTask: (id: string) => void;
  onDeleteAllTasks: () => void;
  onToggleTaskStar: (id: string) => void;
  onRenameTask: (id: string, name: string) => void;
  onGenerateTaskName: (id: string) => Promise<void>;
  onSubmitTask: (t: {
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
    /** 任务关联的 git 根（worktree 创建于此） */
    repoPath: string;
  }) => void;
  onRunTodoTask: (task: Task) => void;
  onUpdateTodo: (
    taskId: string,
    updates: { prompt: string; agent: AgentType; permissionMode: PermissionMode },
  ) => void;
  onFinalizeYunxiaoTodo: (taskId: string, prompt: string, supplement: YunxiaoSupplement) => void;
  onYunxiaoDraftChange: (taskId: string, fields: Record<string, string>) => void;
  onStartYunxiaoDiscussion: (
    taskId: string,
    prompt: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
  onGenerateWritebackSummary: (taskId: string, force?: boolean) => Promise<string>;
  onWritebackYunxiao: (
    taskId: string,
    content: string,
  ) => Promise<YunxiaoWritebackResult>;
  onRetryWritebackScoreField: (taskId: string, value: number) => Promise<void>;
  onGenerateKnowledgeSedimentation: (
    taskId: string,
    force?: boolean,
  ) => Promise<KnowledgeSuggestion[]>;
  onCreateKnowledgeIssues: (
    taskId: string,
    suggestions: KnowledgeSuggestion[],
  ) => Promise<string[]>;
  onCancelTask: (id: string) => void;
  onResumeTask: (id: string) => void;
  /** 任务已结束时：恢复其会话，待 PTY 就绪后自动把 data 写入（决策 9） */
  onResumeTaskAndSend: (taskId: string, data: string) => void;
  onForkTask: (id: string, name: string) => void;
  onMergeWorktree: (id: string) => Promise<void>;
  onDiscardWorktree: (id: string) => Promise<void>;
  onReconnectTask: (id: string) => void;
  onMarkTaskDone: (id: string) => void;
  onInput: (taskId: string, data: string) => void;
  onResize: (taskId: string, cols: number, rows: number) => void;
  onRegisterTerminal: (
    taskId: string,
    writeFn: ((data: string, callback?: () => void) => void) | null,
  ) => number;
  onTerminalReady: (taskId: string, generation: number) => void;
  onSnapshot: (taskId: string, snapshot: string) => void;
  onBack: () => void;
  onSwitchProject: (project: Project) => void;
  onCommitProjectOrder: (draggedId: string, beforeId: string | null, visibleIds: string[]) => void;
  onOpen: () => void;
  themeVariant: ThemeVariant;
  themeMode: ThemeMode;
  systemPrefersDark: boolean;
  onThemeModeChange: (mode: ThemeMode) => void;
  onToggleTheme: () => void;
  terminalFontSize: TerminalFontSize;
  onTerminalFontSizeChange: (size: TerminalFontSize) => void;
  taskDisplayWindow: TaskDisplayWindow;
  onTaskDisplayWindowChange: (window: TaskDisplayWindow) => void;
  attentionBadge: boolean;
  onAttentionBadgeChange: (enabled: boolean) => void;
  terminalScrollback: TerminalScrollback;
  onTerminalScrollbackChange: (value: TerminalScrollback) => void;
  uiFontFamily: FontFamily;
  onUiFontFamilyChange: (family: FontFamily) => void;
  monoFontFamily: FontFamily;
  onMonoFontFamilyChange: (family: FontFamily) => void;
  hubMode?: boolean;
  onExitSkillHub?: () => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const {
    rightPanel,
    openFiles,
    activeFilePath,
    openDiff,
    rightPanelWidth,
    terminalHeight,
    setOpenDiff,
    openRightPanel,
    handleTogglePanel,
    handleFileSelect,
    handleFileTabSelect,
    handleFileTabClose,
    handleCloseOtherFileTabs,
    handleCloseTabsToRight,
    handleCloseTabsToLeft,
    handleCloseAllFileTabs,
    handleDiffFileSelect,
    handleCommitSelect,
    handleCommitFileClick,
    clearFileAndDiff,
    handleRightResizeStart,
    handleTerminalResizeStart,
  } = useProjectPanels();

  const [showShellTerminal, setShowShellTerminal] = useState(false);
  const [shellProjectPath, setShellProjectPath] = useState(project.path);
  const [showSettings, setShowSettings] = useState(false);
  const [showFileSearch, setShowFileSearch] = useState(false);
  const [taskPanelCollapsed, setTaskPanelCollapsed] = useState(false);
  const [mountedTaskIds, setMountedTaskIds] = useState<Set<string>>(() => new Set());
  const [batches, setBatches] = useState<BranchBatch[]>([]);
  const [worktreeScope, setWorktreeScope] = useState<string>("");

  const loadBatches = useCallback(async () => {
    try {
      const list = await invoke<BranchBatch[]>("list_branch_batches", { projectId: project.id });
      setBatches(list);
    } catch (e) {
      console.error("[project] load batches failed:", e);
    }
  }, [project.id]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  const handleScopeChange = useCallback(
    (path: string) => {
      setWorktreeScope(path);
      void loadBatches();
    },
    [loadBatches],
  );
  const shellRef = useRef<ShellTerminalPanelHandle>(null);
  const pendingCmdRef = useRef<string | null>(null);
  const prevHadDiffRef = useRef(false);
  const newTaskDraftRef = useRef<NewTaskDraft | null>(null);
  const handleCacheNewTaskDraft = useCallback((draft: NewTaskDraft | null) => {
    newTaskDraftRef.current = draft;
  }, []);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === project.id),
    [tasks, project.id],
  );
  const selectedTask = projectTasks.find((t) => t.id === selectedTaskId) ?? null;

  const worktreeOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: Array<{ key: string; label: string }> = [{ key: "", label: "主检出" }];
    for (const task of projectTasks) {
      if (task.worktreePath && !task.worktreeDiscarded && !seen.has(task.worktreePath)) {
        seen.add(task.worktreePath);
        options.push({
          key: task.worktreePath,
          label: `WorkTree · ${task.worktreeBranch ?? "?"}`,
        });
      }
    }
    for (const batch of batches) {
      if (batch.status === "merged" || batch.status === "closed") continue;
      const key = `${project.path}/.nezha/worktrees/${batch.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, label: `WorkTree · ${batch.branch}` });
    }
    return options;
  }, [projectTasks, batches, project.path]);

  // 工作区项目可能包含多个 sub-repo，selectedRoot.path 为当前活动的 git 根（缺省回落 project.path）。
  const {
    roots: gitRoots,
    selectedRoot,
    setSelectedRoot,
  } = useGitRoots(project.id, project.path, visible);
  const subRepoPath = selectedRoot?.path ?? project.path;

  // Worktree 任务固定归属于创建它的 git 根。选中这类任务时，仓库选择器、BranchBar
  // 和 Git 面板必须保持同一上下文，不能让全局 sub-repo 选择把界面拆成两个仓库。
  const {
    displayedRepoPath,
    commandRepoPath: gitContextPath,
    selectionLocked: repoSelectionLocked,
  } = resolveProjectGitContext(project.path, subRepoPath, selectedTask);

  const previousGitContextRef = useRef(gitContextPath);
  useEffect(() => {
    if (previousGitContextRef.current === gitContextPath) return;
    previousGitContextRef.current = gitContextPath;
    // diff 的 path/hash 都属于旧仓库；切换上下文后继续复用会展示另一个仓库的内容。
    setOpenDiff(null);
  }, [gitContextPath, setOpenDiff]);

  const handleSearchFileSelect = useCallback(
    (path: string, name: string) => {
      handleFileSelect(path, name);
      openRightPanel("files");
    },
    [handleFileSelect, openRightPanel],
  );

  // 只挂载当前选中的任务的 xterm 实例，其他任务通过 snapshot 序列化后卸载。
  // 这样同时只有 1 个 WebGL context 存活，避免长时间运行后 GPU 内存累积。
  useEffect(() => {
    if (selectedTaskId && !isNewTask) {
      setMountedTaskIds((prev) => {
        if (prev.size === 1 && prev.has(selectedTaskId)) return prev;
        return new Set([selectedTaskId]);
      });
    }
  }, [selectedTaskId, isNewTask]);

  // diff viewer 打开/关闭时自动联动任务面板的折叠态，但只在 "无 diff → 有 diff" 或
  // "有 diff → 无 diff" 跨界的那一刻同步一次。用户中途手动展/收，以及切换不同 diff
  // 文件（openDiff 引用变化但仍是 truthy）都不会被覆盖。
  useEffect(() => {
    const hasDiff = Boolean(openDiff);
    if (hasDiff !== prevHadDiffRef.current) {
      setTaskPanelCollapsed(hasDiff);
      prevHadDiffRef.current = hasDiff;
    }
  }, [openDiff]);

  const handleSelectTask = useCallback(
    (id: string) => {
      clearFileAndDiff();
      onSelectTask(id);
    },
    [onSelectTask, clearFileAndDiff],
  );

  const handleRunMakeTarget = useCallback(
    (target: string) => {
      const cmd = `make ${target}\n`;
      if (showShellTerminal && shellRef.current) {
        const sent = shellRef.current.sendCommandToPath(project.path, cmd);
        if (!sent) {
          showToast(t("terminal.limitReachedWithCloseHint"), "warning");
        }
      } else {
        setShellProjectPath(project.path);
        pendingCmdRef.current = cmd;
        setShowShellTerminal(true);
      }
    },
    [project.path, showShellTerminal, showToast, t],
  );

  const handleOpenWorktreeTerminal = useCallback(
    (worktreePath: string) => {
      if (showShellTerminal && shellRef.current) {
        const opened = shellRef.current.openPath(worktreePath);
        if (!opened) {
          showToast(t("terminal.limitReachedWithCloseHint"), "warning");
        }
        return;
      }
      setShellProjectPath(worktreePath);
      setShowShellTerminal(true);
    },
    [showShellTerminal, showToast, t],
  );

  const handleToggleShellTerminal = useCallback(() => {
    setShowShellTerminal((currentlyVisible) => {
      if (!currentlyVisible) {
        setShellProjectPath(project.path);
      }
      return !currentlyVisible;
    });
  }, [project.path]);

  useEffect(() => {
    if (showShellTerminal) return;
    setShellProjectPath(project.path);
  }, [project.id, project.path, showShellTerminal]);

  const handleShellReady = useCallback(() => {
    if (pendingCmdRef.current) {
      shellRef.current?.sendCommand(pendingCmdRef.current);
      pendingCmdRef.current = null;
    }
  }, []);

  const handleShellClose = useCallback(() => {
    setShowShellTerminal(false);
    setShellProjectPath(project.path);
  }, [project.path]);

  const handleNewTask = useCallback(() => {
    clearFileAndDiff();
    onNewTask();
  }, [onNewTask, clearFileAndDiff]);

  const handleCreateTaskInGroup = useCallback(
    (groupKey: string) => {
      if (groupKey.startsWith("batch:")) {
        const id = groupKey.slice("batch:".length);
        const batch = batches.find((b) => b.id === id);
        if (batch) setWorktreeScope(`${project.path}/.nezha/worktrees/${batch.id}`);
      } else if (groupKey.startsWith("wt:")) {
        setWorktreeScope(groupKey.slice("wt:".length));
      }
      handleNewTask();
    },
    [batches, project.path, handleNewTask],
  );

  const collapseTaskPanelForNewDiff = useCallback(() => {
    if (!openDiff) {
      setTaskPanelCollapsed(true);
    }
  }, [openDiff]);

  const handleDiffFileSelectWithCollapse = useCallback(
    (filePath: string, staged: boolean, label: string) => {
      collapseTaskPanelForNewDiff();
      handleDiffFileSelect(filePath, staged, label);
    },
    [collapseTaskPanelForNewDiff, handleDiffFileSelect],
  );

  const handleCommitSelectWithCollapse = useCallback(
    (hash: string, message: string) => {
      collapseTaskPanelForNewDiff();
      handleCommitSelect(hash, message);
    },
    [collapseTaskPanelForNewDiff, handleCommitSelect],
  );

  const handleCommitFileClickWithCollapse = useCallback(
    (hash: string, filePath: string, label: string) => {
      collapseTaskPanelForNewDiff();
      handleCommitFileClick(hash, filePath, label);
    },
    [collapseTaskPanelForNewDiff, handleCommitFileClick],
  );

  const currentTaskCreatedAt = selectedTask?.createdAt ?? null;

  // ── 云效回写弹窗（V3）：生成汇总预览 → 人工确认 → 发布评论 ──────────────
  const [writebackDialog, setWritebackDialog] = useState<{
    taskId: string;
    preview: string;
    generating: boolean;
    posting: boolean;
    error: string | null;
    warning: string | null;
    retryScoreValue: number | null;
    fieldRetrying: boolean;
    posted: boolean;
  } | null>(null);

  const runWritebackGeneration = useCallback(
    async (taskId: string, force = false) => {
      setWritebackDialog((prev) =>
        prev && prev.taskId === taskId
          ? {
              ...prev,
              generating: true,
              error: null,
              warning: null,
              fieldRetrying: false,
              posted: false,
            }
          : {
              taskId,
              preview: "",
              generating: true,
              posting: false,
              error: null,
              warning: null,
              retryScoreValue: null,
              fieldRetrying: false,
              posted: false,
            },
      );
      try {
        const summary = await onGenerateWritebackSummary(taskId, force);
        setWritebackDialog((prev) =>
          prev && prev.taskId === taskId
            ? { ...prev, preview: summary, generating: false }
            : prev,
        );
      } catch (err) {
        setWritebackDialog((prev) =>
          prev && prev.taskId === taskId
            ? { ...prev, generating: false, error: String(err) }
            : prev,
        );
      }
    },
    [onGenerateWritebackSummary],
  );

  const openWriteback = useCallback(
    (taskId: string) => {
      void runWritebackGeneration(taskId);
    },
    [runWritebackGeneration],
  );

  const postWriteback = useCallback(async () => {
    if (!writebackDialog || writebackDialog.posting || writebackDialog.generating) return;
    const content = writebackDialog.preview.trim();
    if (!content) {
      setWritebackDialog((prev) =>
        prev ? { ...prev, error: t("yunxiao.writeback.empty") } : prev,
      );
      return;
    }
    setWritebackDialog((prev) =>
      prev ? { ...prev, posting: true, error: null } : prev,
    );
    try {
      const result = await onWritebackYunxiao(writebackDialog.taskId, content);
      const serial = projectTasks.find((c) => c.id === writebackDialog.taskId)
        ?.yunxiaoSerialNumber;
      showToast(t("yunxiao.writeback.postSuccess", { serial: serial ?? "" }), "success");
      if (result.warning && result.scoreValue != null && !result.fieldWritten) {
        // 评论已发布但字段写入失败：留在弹窗里，提供「补写字段」重试入口
        setWritebackDialog((prev) =>
          prev
            ? {
                ...prev,
                posting: false,
                posted: true,
                warning: result.warning,
                retryScoreValue: result.scoreValue,
              }
            : prev,
        );
        return;
      }
      if (result.warning) {
        showToast(result.warning, "warning");
      }
      setWritebackDialog(null);
    } catch (err) {
      setWritebackDialog((prev) =>
        prev ? { ...prev, posting: false, error: String(err) } : prev,
      );
    }
  }, [writebackDialog, onWritebackYunxiao, projectTasks, showToast, t]);

  const retryWritebackScoreField = useCallback(async () => {
    if (!writebackDialog || writebackDialog.retryScoreValue == null) return;
    setWritebackDialog((prev) =>
      prev ? { ...prev, fieldRetrying: true, warning: null } : prev,
    );
    try {
      await onRetryWritebackScoreField(
        writebackDialog.taskId,
        writebackDialog.retryScoreValue,
      );
      showToast(t("yunxiao.writeback.fieldRetried"), "success");
      setWritebackDialog(null);
    } catch (err) {
      setWritebackDialog((prev) =>
        prev
          ? {
              ...prev,
              fieldRetrying: false,
              warning: t("yunxiao.writeback.fieldRetryFailed", { error: String(err) }),
            }
          : prev,
      );
    }
  }, [writebackDialog, onRetryWritebackScoreField, showToast, t]);

  // ── 知识沉淀弹窗：headless 提取候选 → 逐条编辑/勾选 → 批量创建云效审核议题 ──
  const [knowledgeDialog, setKnowledgeDialog] = useState<{
    taskId: string;
    suggestions: KnowledgeSuggestion[];
    generating: boolean;
    creating: boolean;
    error: string | null;
    selected: Set<number>;
  } | null>(null);

  const openKnowledgeSedimentation = useCallback(
    (taskId: string, force = false) => {
      setKnowledgeDialog({
        taskId,
        suggestions: [],
        generating: true,
        creating: false,
        error: null,
        selected: new Set(),
      });
      onGenerateKnowledgeSedimentation(taskId, force)
        .then((suggestions) => {
          setKnowledgeDialog((prev) =>
            prev && prev.taskId === taskId
              ? {
                  ...prev,
                  suggestions,
                  generating: false,
                  selected: new Set(suggestions.map((_, i) => i)),
                }
              : prev,
          );
        })
        .catch((err) => {
          setKnowledgeDialog((prev) =>
            prev && prev.taskId === taskId
              ? { ...prev, generating: false, error: String(err) }
              : prev,
          );
        });
    },
    [onGenerateKnowledgeSedimentation],
  );

  const createKnowledgeIssues = useCallback(async () => {
    if (!knowledgeDialog || knowledgeDialog.creating || knowledgeDialog.generating) return;
    const selected = [...knowledgeDialog.selected]
      .map((i) => knowledgeDialog.suggestions[i])
      .filter((s): s is KnowledgeSuggestion => Boolean(s));
    if (selected.length === 0) {
      setKnowledgeDialog((prev) =>
        prev ? { ...prev, error: t("yunxiao.knowledge.empty") } : prev,
      );
      return;
    }
    setKnowledgeDialog((prev) =>
      prev ? { ...prev, creating: true, error: null } : prev,
    );
    try {
      const created = await onCreateKnowledgeIssues(knowledgeDialog.taskId, selected);
      showToast(
        t("yunxiao.knowledge.created", { created: created.length, total: selected.length }),
        "success",
      );
      setKnowledgeDialog(null);
    } catch (err) {
      setKnowledgeDialog((prev) =>
        prev ? { ...prev, creating: false, error: String(err) } : prev,
      );
    }
  }, [knowledgeDialog, onCreateKnowledgeIssues, showToast, t]);

  // ── 行级 Review 评论（纯前端内存态，决策 6：不持久化） ─────────────────
  const [reviewComments, setReviewComments] = useState<ReviewComment[]>([]);
  // diff 审核批注（决策 3：独立存储，与文件批注互不干扰；键控粒度见 diffReview.ts）。
  const [diffComments, setDiffComments] = useState<DiffReviewComment[]>([]);
  // 发送对话框：待发送的评论（open 时由 drawer 传入）。
  const [sendDialog, setSendDialog] = useState<{ comments: ReviewComment[] } | null>(null);

  // 切项目清空（决策 6：评论是项目会话级产物）。
  useEffect(() => {
    setReviewComments([]);
    setDiffComments([]);
    setSendDialog(null);
    setWritebackDialog(null);
  }, [project.id]);

  const handleCreateComment = useCallback(
    (draft: CommentDraft) => {
      const anchorTask = resolveTargetTask(projectTasks);
      setReviewComments((prev) => [
        ...prev,
        {
          ...draft,
          id: newCommentId(),
          status: "open",
          taskId: anchorTask?.id,
          createdAt: Date.now(),
        },
      ]);
    },
    [projectTasks],
  );

  const handleUpdateCommentText = useCallback((id: string, text: string) => {
    setReviewComments((prev) =>
      prev.map((comment) => (comment.id === id ? { ...comment, text } : comment)),
    );
  }, []);

  const handleDeleteComment = useCallback((id: string) => {
    setReviewComments((prev) => prev.filter((comment) => comment.id !== id));
  }, []);

  const handleToggleCommentStatus = useCallback((id: string) => {
    setReviewComments((prev) =>
      prev.map((comment) =>
        comment.id === id
          ? { ...comment, status: comment.status === "resolved" ? "open" : "resolved" }
          : comment,
      ),
    );
  }, []);

  const handleSendComments = useCallback(
    (commentIds: string[]) => {
      const comments = commentIds
        .map((id) => reviewComments.find((c) => c.id === id))
        .filter((c): c is ReviewComment => Boolean(c));
      if (comments.length === 0) return;
      const target = fallbackTarget(projectTasks);
      if (!target) {
        showToast(t("reviewComments.noTargetTask"), "warning");
        return;
      }
      setSendDialog({ comments });
    },
    [reviewComments, projectTasks, showToast, t],
  );

  const handleCreateDiffComment = useCallback(
    (draft: DiffCommentDraft) => {
      const anchorTask = resolveTargetTask(projectTasks);
      setDiffComments((prev) => [
        ...prev,
        {
          id: newCommentId(),
          path: draft.path,
          startLine: draft.line,
          endLine: draft.line,
          snippet: draft.snippet,
          text: draft.text,
          status: "open",
          anchorable: draft.anchorable,
          diffKey: draft.diffKey,
          taskId: anchorTask?.id,
          createdAt: Date.now(),
        },
      ]);
    },
    [projectTasks],
  );

  const handleUpdateDiffCommentText = useCallback((id: string, text: string) => {
    setDiffComments((prev) =>
      prev.map((comment) => (comment.id === id ? { ...comment, text } : comment)),
    );
  }, []);

  const handleDeleteDiffComment = useCallback((id: string) => {
    setDiffComments((prev) => prev.filter((comment) => comment.id !== id));
  }, []);

  const handleToggleDiffCommentStatus = useCallback((id: string) => {
    setDiffComments((prev) =>
      prev.map((comment) =>
        comment.id === id
          ? { ...comment, status: comment.status === "resolved" ? "open" : "resolved" }
          : comment,
      ),
    );
  }, []);

  const handleSendDiffComments = useCallback(
    (commentIds: string[]) => {
      const comments = commentIds
        .map((id) => diffComments.find((c) => c.id === id))
        .filter((c): c is DiffReviewComment => Boolean(c));
      if (comments.length === 0) return;
      const target = fallbackTarget(projectTasks);
      if (!target) {
        showToast(t("reviewComments.noTargetTask"), "warning");
        return;
      }
      setSendDialog({ comments });
    },
    [diffComments, projectTasks, showToast, t],
  );

  const handleSendDialogSend = useCallback(
    (taskId: string, mode: SendMode) => {
      if (!sendDialog) return;
      const task = projectTasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      const comments = sendDialog.comments;
      if (comments.length === 0) return;
      const message = buildBatchMessage(comments);

      if (mode === "direct") {
        onInput(task.id, `${message}\r`);
      } else if (mode === "resume") {
        onResumeTaskAndSend(task.id, `${message}\r`);
      } else {
        // 作为新任务发：带上原任务 prompt 作上下文（决策 4）
        const prompt = [task.prompt, message].filter(Boolean).join("\n\n");
        onSubmitTask({
          prompt,
          agent: task.agent,
          permissionMode: task.permissionMode,
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          images: [],
          texts: [],
          immediate: true,
          launchMode: "local",
          baseBranch: "",
          repoPath: subRepoPath,
        });
      }

      const sentIds = new Set(comments.map((c) => c.id));
      setReviewComments((prev) =>
        prev.map((comment) =>
          sentIds.has(comment.id) && !comment.sentAt
            ? { ...comment, sentAt: Date.now(), taskId: comment.taskId ?? task.id }
            : comment,
        ),
      );
      setSendDialog(null);
      showToast(t("reviewComments.sentToast", { count: comments.length, name: task.name ?? task.id }));
    },
    [sendDialog, projectTasks, onInput, onResumeTaskAndSend, onSubmitTask, subRepoPath, showToast, t],
  );

  return (
    <div style={visible ? s.projectBodyVisible : s.projectBodyHidden}>
      <ProjectRail
        projects={allProjects}
        allTasks={tasks}
        activeProjectId={project.id}
        attentionBadge={attentionBadge}
        onSwitch={onSwitchProject}
        onCommitProjectOrder={onCommitProjectOrder}
        onOpen={onOpen}
        singleProjectMode={hubMode}
      />
      <TaskPanel
        project={project}
        repoPath={displayedRepoPath}
        branchRepoPath={gitContextPath}
        repoSelectionLocked={repoSelectionLocked}
        gitRoots={gitRoots}
        onSelectRoot={setSelectedRoot}
        tasks={projectTasks}
        selectedId={selectedTaskId}
        isNewTask={isNewTask}
        onNewTask={handleNewTask}
        onSelectTask={handleSelectTask}
        onDeleteTask={onDeleteTask}
        onDeleteAllTasks={onDeleteAllTasks}
        onToggleTaskStar={onToggleTaskStar}
        onRunTodo={onRunTodoTask}
        batches={batches}
        onCreateTaskInGroup={handleCreateTaskInGroup}
        onBack={hubMode ? (onExitSkillHub ?? onBack) : onBack}
        backTitle={hubMode ? t("skill.taskView.back") : undefined}
        themeVariant={themeVariant}
        themeMode={themeMode}
        systemPrefersDark={systemPrefersDark}
        onThemeModeChange={onThemeModeChange}
        onToggleTheme={onToggleTheme}
        terminalFontSize={terminalFontSize}
        onTerminalFontSizeChange={onTerminalFontSizeChange}
        taskDisplayWindow={taskDisplayWindow}
        onTaskDisplayWindowChange={onTaskDisplayWindowChange}
        attentionBadge={attentionBadge}
        onAttentionBadgeChange={onAttentionBadgeChange}
        terminalScrollback={terminalScrollback}
        onTerminalScrollbackChange={onTerminalScrollbackChange}
        uiFontFamily={uiFontFamily}
        onUiFontFamilyChange={onUiFontFamilyChange}
        monoFontFamily={monoFontFamily}
        onMonoFontFamilyChange={onMonoFontFamilyChange}
        active={visible}
        collapsed={taskPanelCollapsed}
        onToggleCollapsed={() => setTaskPanelCollapsed((v) => !v)}
      />
      <div style={s.mainContent}>
        <div style={s.projectMainStage}>
          {/* Foreground: file viewer, diff, or new-task composer */}
          <ErrorBoundary
            label="主内容区"
            fallback={(error, reset) => (
              <div style={s.errorBoundaryWrap}>
                <div style={s.errorBoundaryIcon}>⚠</div>
                <div style={s.errorBoundaryTitle}>内容区渲染出错</div>
                <div style={s.errorBoundaryMessage}>{error.message || "未知错误"}</div>
                <div style={s.errorBoundaryActions}>
                  <button onClick={reset} style={s.errorBoundaryBtn}>
                    重试
                  </button>
                  <button
                    onClick={() => {
                      clearFileAndDiff();
                      reset();
                    }}
                    style={s.errorBoundaryBtn}
                  >
                    返回任务视图
                  </button>
                </div>
              </div>
            )}
          >
            {openDiff ? (
              openDiff.kind === "file" ? (
                <GitDiffViewer
                  projectRoot={project.path}
                  repoPath={gitContextPath}
                  mode="file"
                  filePath={openDiff.filePath}
                  staged={openDiff.staged}
                  title={openDiff.label}
                  onClose={() => setOpenDiff(null)}
                  comments={diffComments}
                  onCreateComment={handleCreateDiffComment}
                  onUpdateCommentText={handleUpdateDiffCommentText}
                  onDeleteComment={handleDeleteDiffComment}
                  onToggleCommentStatus={handleToggleDiffCommentStatus}
                  onSendComments={handleSendDiffComments}
                />
              ) : openDiff.kind === "commit-file" ? (
                <GitDiffViewer
                  projectRoot={project.path}
                  repoPath={gitContextPath}
                  mode="commit-file"
                  commitHash={openDiff.hash}
                  filePath={openDiff.filePath}
                  title={openDiff.label}
                  onClose={() => setOpenDiff(null)}
                  comments={diffComments}
                  onCreateComment={handleCreateDiffComment}
                  onUpdateCommentText={handleUpdateDiffCommentText}
                  onDeleteComment={handleDeleteDiffComment}
                  onToggleCommentStatus={handleToggleDiffCommentStatus}
                  onSendComments={handleSendDiffComments}
                />
              ) : (
                <GitDiffViewer
                  projectRoot={project.path}
                  repoPath={gitContextPath}
                  mode="commit"
                  commitHash={openDiff.hash}
                  title={openDiff.message}
                  onClose={() => setOpenDiff(null)}
                  comments={diffComments}
                  onCreateComment={handleCreateDiffComment}
                  onUpdateCommentText={handleUpdateDiffCommentText}
                  onDeleteComment={handleDeleteDiffComment}
                  onToggleCommentStatus={handleToggleDiffCommentStatus}
                  onSendComments={handleSendDiffComments}
                />
              )
            ) : openFiles.length > 0 ? (
              <FileViewer
                tabs={openFiles}
                activeFilePath={activeFilePath}
                projectPath={project.path}
                onSelectTab={handleFileTabSelect}
                onCloseTab={handleFileTabClose}
                onCloseOtherTabs={handleCloseOtherFileTabs}
                onCloseTabsToRight={handleCloseTabsToRight}
                onCloseTabsToLeft={handleCloseTabsToLeft}
                onCloseAllTabs={handleCloseAllFileTabs}
                themeVariant={themeVariant}
                onRunMakeTarget={handleRunMakeTarget}
                comments={reviewComments}
                onCreateComment={handleCreateComment}
                onUpdateCommentText={handleUpdateCommentText}
                onDeleteComment={handleDeleteComment}
                onToggleCommentStatus={handleToggleCommentStatus}
                onSendComments={handleSendComments}
              />
            ) : isNewTask || !selectedTask ? (
              <NewTaskView
                project={project}
                repoPath={subRepoPath}
                roots={gitRoots}
                onSetRepoPath={setSelectedRoot}
                otherProjects={otherProjects}
                onSubmit={(t) => onSubmitTask({ ...t, repoPath: subRepoPath })}
                initialDraft={newTaskDraftRef.current}
                onCacheDraft={handleCacheNewTaskDraft}
              />
            ) : selectedTask.status === ("todo" as TaskStatus) ? (
              selectedTask.yunxiaoWorkitemId ? (
                <YunxiaoIssueDetailView
                  task={selectedTask}
                  projectPath={project.path}
                  onBack={onBack}
                  onFinalize={onFinalizeYunxiaoTodo}
                  onDraftChange={onYunxiaoDraftChange}
                  onStartDiscussion={onStartYunxiaoDiscussion}
                />
              ) : (
                <TodoTaskView
                  task={selectedTask}
                  onRunTodo={onRunTodoTask}
                  onUpdateTodo={onUpdateTodo}
                />
              )
            ) : null}
          </ErrorBoundary>

          {/* Background terminals */}
          {projectTasks
            .filter((t) => mountedTaskIds.has(t.id))
            .map((task) => {
              const isVisible =
                openFiles.length === 0 &&
                !openDiff &&
                !isNewTask &&
                !!selectedTask &&
                task.id === selectedTaskId &&
                task.status !== "todo";
              const worktreePath =
                task.worktreePath && !task.worktreeDiscarded ? task.worktreePath : null;
              return (
                <RunningView
                  key={task.id}
                  task={task}
                  projectPath={project.path}
                  runCount={taskRunCounts[task.id] ?? 0}
                  visible={visible && isVisible}
                  projectActive={visible}
                  onCancel={() => onCancelTask(task.id)}
                  onResume={() => onResumeTask(task.id)}
                  onFork={(name) => onForkTask(task.id, name)}
                  onMergeWorktree={() => onMergeWorktree(task.id)}
                  onDiscardWorktree={() => onDiscardWorktree(task.id)}
                  onOpenWriteback={() => openWriteback(task.id)}
                  onOpenKnowledgeSedimentation={() => openKnowledgeSedimentation(task.id)}
                  onOpenWorktreeTerminal={
                    worktreePath ? () => handleOpenWorktreeTerminal(worktreePath) : undefined
                  }
                  onReconnect={() => onReconnectTask(task.id)}
                  onMarkDone={() => onMarkTaskDone(task.id)}
                  onInput={(data) => onInput(task.id, data)}
                  onResize={(cols, rows) => onResize(task.id, cols, rows)}
                  onRegisterTerminal={(fn) => onRegisterTerminal(task.id, fn)}
                  onTerminalReady={(generation) => onTerminalReady(task.id, generation)}
                  onSnapshot={(snapshot) => onSnapshot(task.id, snapshot)}
                  getRestoreState={() => getTaskRestoreState(task.id)}
                  onRename={(name) => onRenameTask(task.id, name)}
                  onGenerateName={() => onGenerateTaskName(task.id)}
                  themeVariant={themeVariant}
                  terminalFontSize={terminalFontSize}
                  terminalScrollback={terminalScrollback}
                  monoFontFamily={monoFontFamily}
                />
              );
            })}
        </div>
        {showShellTerminal && (
          <ShellTerminalPanel
            ref={shellRef}
            projectPath={shellProjectPath}
            projectId={project.id}
            isActive={visible}
            onClose={handleShellClose}
            themeVariant={themeVariant}
            terminalFontSize={terminalFontSize}
            monoFontFamily={monoFontFamily}
            onReady={handleShellReady}
            height={terminalHeight}
            onResizeStart={handleTerminalResizeStart}
          />
        )}
      </div>

      {rightPanel && (
        <div style={s.rightPanelWrapCol}>
          <div onMouseDown={handleRightResizeStart} style={s.rightPanelResizeHandle} />
          <div style={s.bbScopeBar}>
            <WorktreeScopeSelect
              options={worktreeOptions}
              value={worktreeScope}
              onChange={handleScopeChange}
            />
          </div>
          <div style={s.rpContent}>
          {rightPanel === "files" && (
            <ErrorBoundary label="文件浏览器">
              <FileExplorer
                projectPath={worktreeScope || project.path}
                projectName={project.name}
                onFileSelect={handleFileSelect}
                active={visible}
                width={rightPanelWidth}
              />
            </ErrorBoundary>
          )}
          {rightPanel === "git-changes" && (
            <ErrorBoundary label="Git 变更">
              <GitChanges
                projectRoot={worktreeScope || project.path}
                repoPath={worktreeScope || gitContextPath}
                currentTaskCreatedAt={currentTaskCreatedAt}
                issueTag={
                  selectedTask?.yunxiaoSerialNumber
                    ? issueTag(selectedTask.yunxiaoSerialNumber)
                    : undefined
                }
                onFileSelect={handleDiffFileSelectWithCollapse}
                width={rightPanelWidth}
              />
            </ErrorBoundary>
          )}
          {rightPanel === "git-history" && (
            <ErrorBoundary label="Git 历史">
              <GitHistory
                projectRoot={worktreeScope || project.path}
                repoPath={worktreeScope || gitContextPath}
                onCommitSelect={handleCommitSelectWithCollapse}
                onFileClick={handleCommitFileClickWithCollapse}
                width={rightPanelWidth}
              />
            </ErrorBoundary>
          )}
          {rightPanel === "branch-batch" && (
            <ErrorBoundary label="创建PR">
              <BranchBatchView
                projectPath={project.path}
                projectId={project.id}
                tasks={projectTasks}
                worktreeScope={worktreeScope}
                onScopeChange={handleScopeChange}
                onClose={() => handleTogglePanel("branch-batch")}
              />
            </ErrorBoundary>
          )}
          {rightPanel === "build" && (
            <ErrorBoundary label="构建">
              <BuildPanel
                projectPath={worktreeScope || project.path}
                width={rightPanelWidth}
                worktreePath={worktreeScope || undefined}
                onCreateFixTask={(t) =>
                  onSubmitTask({
                    prompt: t.prompt,
                    agent: t.agent as AgentType,
                    permissionMode: t.permissionMode as PermissionMode,
                    model: undefined,
                    reasoningEffort: undefined,
                    images: [],
                    texts: [],
                    immediate: true,
                    launchMode: t.launchMode,
                    baseBranch: t.baseBranch,
                    repoPath: t.repoPath,
                  })
                }
              />
            </ErrorBoundary>
          )}
        </div>
      </div>
      )}

      <RightToolbar
        activePanel={rightPanel}
        onToggle={handleTogglePanel}
        terminalActive={showShellTerminal}
        onToggleTerminal={handleToggleShellTerminal}
        onOpenSearch={() => setShowFileSearch(true)}
        onOpenSettings={() => setShowSettings(true)}
      />

      {showFileSearch && (
        <FileSearchDialog
          projectPath={project.path}
          onFileSelect={handleSearchFileSelect}
          onClose={() => setShowFileSearch(false)}
        />
      )}

      {showSettings && (
        <SettingsDialog projectPath={project.path} onClose={() => setShowSettings(false)} />
      )}

      {sendDialog && (
        <CommentSendDialog
          comments={sendDialog.comments}
          tasks={projectTasks}
          defaultTaskId={resolveTargetTask(projectTasks)?.id ?? null}
          onClose={() => setSendDialog(null)}
          onSend={handleSendDialogSend}
        />
      )}

      {writebackDialog &&
        (() => {
          const writebackTask = projectTasks.find((c) => c.id === writebackDialog.taskId);
          const split = splitValueScoreSection(writebackDialog.preview);
          return (
            <YunxiaoWritebackDialog
              serialNumber={writebackTask?.yunxiaoSerialNumber ?? ""}
              title={writebackTask?.name ?? writebackTask?.prompt.slice(0, 80) ?? ""}
              preview={split.comment}
              scoreSection={split.scoreSection}
              generating={writebackDialog.generating}
              posting={writebackDialog.posting}
              error={writebackDialog.error}
              warning={writebackDialog.warning}
              fieldRetrying={writebackDialog.fieldRetrying}
              retryScoreValue={writebackDialog.retryScoreValue}
              posted={writebackDialog.posted}
              onPreviewChange={(value) =>
                setWritebackDialog((prev) =>
                  prev
                    ? {
                        ...prev,
                        preview: split.scoreSection
                          ? `${value}\n\n${split.scoreSection}`
                          : value,
                      }
                    : prev,
                )
              }
              onRetryField={() => void retryWritebackScoreField()}
              onRegenerate={() => void runWritebackGeneration(writebackDialog.taskId, true)}
              onPost={() => void postWriteback()}
              onClose={() => setWritebackDialog(null)}
            />
          );
        })()}

      {knowledgeDialog &&
        (() => {
          const knowledgeTask = projectTasks.find((c) => c.id === knowledgeDialog.taskId);
          return (
            <KnowledgeSedimentationDialog
              serialNumber={knowledgeTask?.yunxiaoSerialNumber ?? ""}
              title={knowledgeTask?.name ?? knowledgeTask?.prompt.slice(0, 80) ?? ""}
              suggestions={knowledgeDialog.suggestions}
              generating={knowledgeDialog.generating}
              creating={knowledgeDialog.creating}
              error={knowledgeDialog.error}
              selected={knowledgeDialog.selected}
              onToggle={(index) =>
                setKnowledgeDialog((prev) => {
                  if (!prev) return prev;
                  const next = new Set(prev.selected);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return { ...prev, selected: next };
                })
              }
              onSuggestionChange={(index, patch) =>
                setKnowledgeDialog((prev) => {
                  if (!prev) return prev;
                  const suggestions = prev.suggestions.map((s, i) =>
                    i === index ? { ...s, ...patch } : s,
                  );
                  return { ...prev, suggestions };
                })
              }
              onRegenerate={() => openKnowledgeSedimentation(knowledgeDialog.taskId, true)}
              onCreate={() => void createKnowledgeIssues()}
              onClose={() => setKnowledgeDialog(null)}
            />
          );
        })()}
    </div>
  );
}
