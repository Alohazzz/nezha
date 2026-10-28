import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type {
  Task,
  UsageWindow,
  TerminalFontSize,
  TerminalScrollback,
  FontFamily,
  ThemeVariant,
} from "../types";
import type { CodexStreamState } from "../hooks/useCodexStream";import type { AgentModelCatalog } from "./app-settings/types";
import { permissionModeLabel } from "../types";
import { compactSkillMentions } from "../skillMention";
import { StatusIcon } from "./StatusIcon";
import { TerminalView } from "./TerminalView";
import { SessionView } from "./SessionView";
import { CodexStreamView } from "./codex-stream/CodexStreamView";
import { buildDefaultForkTaskName, SessionActionsMenu } from "./running-view/SessionActionsMenu";
import { useToast } from "./Toast";
import { writeClipboardText } from "./file-explorer/clipboard";
import { getUsageColor } from "../utils";
import { useUsageSnapshot } from "../hooks/useUsageSnapshot";
import { ENABLE_USAGE_INSIGHTS } from "../platform";
import { useI18n } from "../i18n";
import s from "../styles";
import {
  X,
  RotateCcw,
  Pencil,
  Sparkles,
  GitMerge,
  GitBranch,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Send,
  BookOpenText,
  Terminal as TerminalIcon,
} from "lucide-react";

interface SessionMetrics {
  duration_secs: number;
  session_file_bytes: number;
  total_tokens: number;
  context_tokens: number;
  context_window: number;
}

function formatDuration(secs: number): string {
  const totalSeconds = Math.max(0, Math.round(secs));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / 1024 / 1024;
    return `${mb.toFixed(mb < 10 ? 1 : 0)}M`;
  }
  const gb = bytes / 1024 / 1024 / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)}G`;
}

function InlineWindow({ label, window }: { label: string; window: UsageWindow }) {
  return (
    <span style={s.usageInlineWindow}>
      <span style={s.usageInlineWindowLabel}>{label}</span>
      <span style={{ ...s.usageInlineWindowValue, color: getUsageColor(window.remainingPercent) }}>
        {window.remainingPercent}%
      </span>
    </span>
  );
}

export function RunningView({
  task,
  projectPath,
  runCount = 0,
  visible = true,
  projectActive = true,
  onCancel,
  onResume,
  onFork,
  onMergeWorktree,
  onDiscardWorktree,
  onOpenWriteback,
  onOpenPlanPreview,
  onOpenWorktreeTerminal,
  onReconnect,
  onMarkDone,
  onInput,
  onResize,
  onRegisterTerminal,
  onTerminalReady,
  onSnapshot,
  getRestoreState,
  codexStream,
  onCodexApprovalResolved,
  onHydrateCodexHistory,
  onCodexUserInputResolved,
  onFollowUp,
  onSetStructuredModel,
  codexStructuredModel,
  codexStructuredEffort,
  onCodexBuiltinAction,
  codexModelCatalog,
  followUpBusy,
  onOpenGitChanges,
  onOpenLink,
  onRename,
  onGenerateName,
  themeVariant,
  terminalFontSize,
  terminalScrollback,
  monoFontFamily,
}: {
  task: Task;
  projectPath: string;
  runCount?: number;
  visible?: boolean;
  projectActive?: boolean;
  onCancel: () => void;
  onResume?: () => void;
  onFork?: (name: string) => void;
  onMergeWorktree?: () => Promise<void>;
  onDiscardWorktree?: () => Promise<void>;
  onOpenWriteback?: () => void;
  /** 打开右侧「方案预览」面板（任务关联了 Plan 时出现顶栏「方案」按钮）。 */
  onOpenPlanPreview?: () => void;
  onOpenWorktreeTerminal?: () => void;
  onReconnect: () => void;
  onMarkDone: () => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onRegisterTerminal: (writeFn: ((data: string, callback?: () => void) => void) | null) => number;
  onTerminalReady: (generation: number) => void;
  onSnapshot?: (snapshot: string) => void;
  getRestoreState?: () => { initialData?: string; initialSnapshot?: string };
  /** 非空 = structured 任务：主内容区渲染结构化流视图而非终端（issue #116 阶段 3）。 */
  codexStream?: CodexStreamState;
  onCodexApprovalResolved?: () => void;
  /** 模型提问已应答（卡片收起；上层清 userInput 槽位）。 */
  onCodexUserInputResolved?: () => void;
  /** structured 任务历史回放（从 rollout 会话文件恢复流视图）。 */
  onHydrateCodexHistory?: (sessionPath: string) => void;
  /** structured 任务 done 态的继续对话（thread/resume 通道）；busy 期间禁用输入。
   *  images 为 dataUrl 数组（issue #118：composer 粘贴/选择的图片随消息发送）。 */
  onFollowUp?: (text: string, images: string[]) => void;
  followUpBusy?: boolean;
  /** structured 任务的模型 / 推理深度切换（`/model` `/effort` 内置命令的写入通道）。
   *  缺省 = composer 不注入内置命令（PTY 等非 structured 场景）。 */
  onSetStructuredModel?: (model: string | undefined, effort: string | undefined) => void;
  /** structured 通道的全局模型 / 思考深度（应用级设置，composer 回显与选择器选中态）。 */
  codexStructuredModel?: string;
  codexStructuredEffort?: string;
  /** structured 任务的非选择器内置命令（`/compact` `/review` `/stop`）。 */
  onCodexBuiltinAction?: (action: "compact" | "review" | "stop") => void;
  /** Codex 模型目录（选择器数据源；仅 structured codex 任务由 ProjectPage 传入）。 */
  codexModelCatalog?: AgentModelCatalog;
  /** 截断 diff → GitChanges 右面板的跳转入口（issue #117 T4）。 */
  onOpenGitChanges?: () => void;
  /** structured 流正文链接点击（沉淀文档打开 / 外链浏览器），ProjectPage 接线。 */
  onOpenLink?: (href: string) => void;
  onRename: (name: string) => void;
  onGenerateName: () => Promise<void>;
  themeVariant: ThemeVariant;
  terminalFontSize: TerminalFontSize;
  terminalScrollback: TerminalScrollback;
  monoFontFamily: FontFamily;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const isActive =
    task.status === "pending" ||
    task.status === "running" ||
    task.status === "input_required" ||
    task.status === "awaiting_review";
  const isDetached = task.status === "detached";
  const isInterrupted = task.status === "interrupted";
  const sessionPath = task.claudeSessionPath ?? task.codexSessionPath ?? task.dshSessionPath;
  const resumeSessionId =
    task.agent === "codex"
      ? task.codexSessionId
      : task.agent === "dsh"
        ? task.dshSessionId
        : task.claudeSessionId;
  // structured 任务恢复走 `resume_codex_structured`（thread/resume 拉起 rollout），
  // 有 thread id 即可恢复——不再沿用阶段 2「隐藏恢复入口」的旧决议（阶段 4 的
  // composer resume 通道已覆盖同语义）；缺 thread id（首 turn 前就中断）时按钮禁用。
  const isStructured = task.runMode === "structured";
  const resumeAvailable =
    isStructured && task.status !== "done"
      ? !!resumeSessionId
      : task.agent === "dsh" || !!resumeSessionId;
  const restoreState = getRestoreState?.() ?? {};

  // structured 任务的历史条目只存在于内存模型里：重开应用 / 打开一个已完成的
  // 历史任务时模型为空，流视图只能显示「没有智能体活动记录」。这里在条目为空
  // 时触发一次 rollout 回放（hook 内部幂等 + 与实时帧竞态保护）。运行中的任务
  // 不回放：实时 Channel 才是权威，回放会与正在到达的帧重复。
  const codexEntryCount = codexStream?.entries.length ?? 0;
  const historyState = codexStream?.history.state ?? "idle";
  useEffect(() => {
    if (!codexStream || !onHydrateCodexHistory) return;
    if (codexEntryCount > 0) return;
    if (!task.codexSessionPath) return;
    // 只有 idle 才发起：loading / ready 不该重复调用，failed 也不自动重试
    // （hook 内部同样按 (taskId, sessionPath) 去重，这里省一次无效调用）。
    if (historyState !== "idle") return;
    onHydrateCodexHistory(task.codexSessionPath);
  }, [codexStream, codexEntryCount, historyState, onHydrateCodexHistory, task.codexSessionPath]);

  const { snapshot: usageSnapshot } = useUsageSnapshot(visible && ENABLE_USAGE_INSIGHTS);

  const [metricsState, setMetricsState] = useState<{
    sessionPath: string;
    status: "loading" | "ready" | "failed";
    metrics: SessionMetrics | null;
  } | null>(null);
  const currentMetricsState = metricsState?.sessionPath === sessionPath ? metricsState : null;
  const metrics = currentMetricsState?.status === "ready" ? currentMetricsState.metrics : null;
  const [editingTitle, setEditingTitle] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [hoverHeader, setHoverHeader] = useState(false);
  const [generatingName, setGeneratingName] = useState(false);
  const [worktreeBusy, setWorktreeBusy] = useState<"merge" | "discard" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [bannerCompact, setBannerCompact] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const interruptedBannerRef = useRef<HTMLDivElement>(null);

  const generateTooltip = generatingName
    ? t("task.generatingName")
    : sessionPath
      ? t("task.generateName")
      : t("task.generateNameNoSession");
  const defaultForkName = buildDefaultForkTaskName(
    task.name,
    task.prompt,
    t("running.untitledTask"),
  );
  const forkDisabledReason = task.worktreePath
    ? t("running.forkWorktreeUnsupported")
    : !onFork || (task.agent !== "dsh" && !resumeSessionId)
      ? t("running.forkUnavailable")
      : undefined;
  // 合并审核发起的 codeup 任务（分支合并/代码审查/处理冲突）已由 Agent 用 git/接口完成合并，
  // 不再展示「合并到 <base>」的 worktree 合并按钮，避免与 git 合并重复/冲突。
  const isCodeupMrTask = (task.name ?? "").match(/^(分支合并|代码审查|处理冲突)\s/);

  const handleGenerateClick = async () => {
    if (generatingName || isActive) return;
    setGeneratingName(true);
    try {
      await onGenerateName();
    } catch {
      // toast already shown by parent handler
    } finally {
      setGeneratingName(false);
    }
  };

  const handleExport = async () => {
    if (exporting || !sessionPath) return;
    setExporting(true);
    try {
      const titleSource = (task.name ?? task.prompt).trim();
      // 仅保留汉字/字母/数字/连字符，其它替换成 _。避免出现非法文件名字符。
      const slug =
        titleSource
          .slice(0, 50)
          .replace(/[^\w\u4e00-\u9fa5-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "session";
      const date = new Date().toISOString().slice(0, 10);
      const defaultName = `nezha-${slug}-${date}.md`;

      const outputPath = await saveDialog({
        title: t("running.exportSaveDialogTitle"),
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!outputPath) return;

      await invoke<void>("export_session_markdown", {
        sessionPath,
        projectPath,
        isCodex: task.agent === "codex",
        outputPath,
        taskMeta: {
          name: task.name,
          prompt: task.prompt,
          agent: task.agent,
          createdAt: task.createdAt,
          sessionId:
            task.agent === "codex"
              ? task.codexSessionId
              : task.agent === "dsh"
                ? task.dshSessionId
                : task.claudeSessionId,
          worktreeBranch: task.worktreeBranch,
          baseBranch: task.baseBranch,
          additions: task.additions,
          deletions: task.deletions,
          failureReason: task.failureReason,
        },
      });
      showToast(t("running.exportSuccess", { path: outputPath }), "success");
    } catch (err) {
      showToast(t("running.exportFailed", { error: String(err) }), "error");
    } finally {
      setExporting(false);
    }
  };

  const handleCopySessionPath = async () => {
    if (!sessionPath) return false;
    try {
      await writeClipboardText(sessionPath);
      return true;
    } catch (err) {
      showToast(t("running.sessionFilePathCopyFailed", { error: String(err) }), "error");
      return false;
    }
  };

  useEffect(() => {
    const el = interruptedBannerRef.current;
    if (!el) return;

    const updateCompact = () => {
      setBannerCompact(el.clientWidth < 820);
    };
    updateCompact();

    const observer = new ResizeObserver(updateCompact);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isDetached, isInterrupted, sessionPath]);

  useEffect(() => {
    if (!sessionPath) {
      setMetricsState(null);
      return;
    }
    const activeSessionPath = sessionPath;
    setMetricsState((prev) =>
      prev?.sessionPath === activeSessionPath ? prev : { sessionPath: activeSessionPath, status: "loading", metrics: null },
    );
    // 只在项目处于前台时才跑 metrics 轮询；切到其他项目时暂停，
    // 项目重新激活时这里会立即补拉一次。注意这里用的是 projectActive
    // 而不是 visible —— 后者在同项目内打开 FileViewer / GitDiff 时也会是 false，
    // 那种场景下不应该中断正在运行任务的 duration 更新。
    if (!projectActive) return;

    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const load = () => {
      invoke<SessionMetrics>("read_session_metrics", { sessionPath: activeSessionPath })
        .then((nextMetrics) => {
          if (cancelled) return;
          setMetricsState({
            sessionPath: activeSessionPath,
            status: "ready",
            metrics: nextMetrics,
          });
        })
        .catch(() => {
          if (cancelled) return;
          setMetricsState({
            sessionPath: activeSessionPath,
            status: "failed",
            metrics: null,
          });
          // 会话文件由 agent 异步落盘：task-session 事件（thread/started）先于
          // 文件创建到达时，非活跃任务不再有轮询兜底，会永久停在 failed 红点。
          // 非活跃时延迟补试一次，文件就绪后自愈。
          if (!isActive && retryTimer === null) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              if (!cancelled) load();
            }, 5000);
          }
        });
    };

    load();
    if (isActive) timer = setInterval(load, 3000);

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
  }, [sessionPath, isActive, projectActive]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
        zIndex: visible ? 1 : 0,
      }}
    >
      {/* Header */}
      <div
        style={s.runHeader}
        onMouseEnter={() => setHoverHeader(true)}
        onMouseLeave={() => setHoverHeader(false)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
          <StatusIcon status={task.status} />
          {editingTitle ? (
            <input
              ref={titleInputRef}
              style={{
                maxWidth: 420,
                width: "100%",
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                background: "transparent",
                border: "none",
                borderBottom: "2px solid var(--border-strong)",
                borderRadius: 0,
                padding: "0 2px",
                outline: "none",
              }}
              value={editValue}
              placeholder={compactSkillMentions(task.prompt).slice(0, 60)}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onRename(editValue.trim());
                  setEditingTitle(false);
                }
                if (e.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              onBlur={() => {
                onRename(editValue.trim());
                setEditingTitle(false);
              }}
            />
          ) : (
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {(() => {
                const t = task.name ?? compactSkillMentions(task.prompt);
                return t.slice(0, 70) + (t.length > 70 ? "…" : "");
              })()}
            </span>
          )}
          {sessionPath && !editingTitle && (
            <button
              type="button"
              title={t("task.renameTask")}
              style={{
                ...s.taskRenameBtn,
                flexShrink: 0,
                color: "var(--text-secondary)",
                opacity: hoverHeader ? 1 : 0.65,
                background: hoverHeader ? "var(--bg-input)" : "transparent",
                transition: "opacity 0.15s ease, background 0.15s ease",
              }}
              onClick={() => {
                setEditValue(task.name ?? "");
                setEditingTitle(true);
                setTimeout(() => titleInputRef.current?.focus(), 0);
              }}
            >
              <Pencil size={13} strokeWidth={2.25} />
            </button>
          )}
          {!editingTitle && (
            <button
              type="button"
              title={generateTooltip}
              disabled={generatingName || isActive}
              style={{
                ...s.taskRenameBtn,
                flexShrink: 0,
                color: isActive ? "var(--text-hint)" : "var(--text-secondary)",
                opacity: generatingName ? 1 : isActive ? 0.4 : hoverHeader ? 1 : 0.65,
                background:
                  hoverHeader && !isActive && !generatingName
                    ? "var(--bg-input)"
                    : "transparent",
                cursor: generatingName || isActive ? "not-allowed" : "pointer",
                transition: "opacity 0.15s ease, background 0.15s ease, color 0.15s ease",
              }}
              onClick={handleGenerateClick}
            >
              <Sparkles
                size={13}
                strokeWidth={2.25}
                className={generatingName ? "spin" : ""}
              />
            </button>
          )}
        </div>
        {task.planId && onOpenPlanPreview && (
          <button type="button" style={s.cancelBtn} onClick={onOpenPlanPreview}>
            <BookOpenText size={12} strokeWidth={2.5} />
            <span>{t("plan.previewButton")}</span>
          </button>
        )}
        {isActive && (
          <>
            {task.worktreePath && !task.worktreeDiscarded && onOpenWorktreeTerminal && (
              <button style={s.cancelBtn} onClick={onOpenWorktreeTerminal}>
                <TerminalIcon size={12} strokeWidth={2.5} />
                <span>{t("running.worktreeTerminal")}</span>
              </button>
            )}
            <button style={s.doneBtn} onClick={onMarkDone}>
              <CheckCircle2 size={12} strokeWidth={2.5} />
              <span>{t("running.markDone")}</span>
            </button>
            <button style={s.cancelBtn} onClick={onCancel}>
              <X size={12} strokeWidth={2.5} />
              <span>{t("running.cancel")}</span>
            </button>
          </>
        )}
        {!isActive &&
          !isDetached &&
          !isInterrupted &&
          onResume &&
          resumeAvailable &&
          !task.worktreeDiscarded && (
            <button style={s.resumeBtn} onClick={onResume}>
              <RotateCcw size={12} strokeWidth={2.5} />
              <span>{t("running.resume")}</span>
            </button>
          )}
        {!isActive &&
          task.status === "done" &&
          task.worktreePath &&
          task.worktreeBranch &&
          !task.worktreeDiscarded &&
          !task.deliveryPlanId &&
          !isCodeupMrTask &&
          onMergeWorktree && (
            <button
              style={{
                ...s.resumeBtn,
                opacity: worktreeBusy ? 0.6 : 1,
                cursor: worktreeBusy ? "not-allowed" : "pointer",
              }}
              disabled={!!worktreeBusy}
              onClick={async () => {
                setWorktreeBusy("merge");
                try {
                  await onMergeWorktree();
                } finally {
                  setWorktreeBusy(null);
                }
              }}
            >
              <GitMerge size={12} strokeWidth={2.5} />
              <span>
                {worktreeBusy === "merge"
                  ? t("running.merging")
                  : t("running.mergeTo", { branch: task.baseBranch ?? "" })}
              </span>
            </button>
          )}
        {!isActive &&
          task.worktreePath &&
          task.worktreeBranch &&
          !task.worktreeDiscarded &&
          !task.deliveryPlanId &&
          onDiscardWorktree && (
          <button
            style={{
              ...s.cancelBtn,
              opacity: worktreeBusy ? 0.6 : 1,
              cursor: worktreeBusy ? "not-allowed" : "pointer",
            }}
            disabled={!!worktreeBusy}
            onClick={async () => {
              setWorktreeBusy("discard");
              try {
                await onDiscardWorktree();
              } finally {
                setWorktreeBusy(null);
              }
            }}
          >
            <Trash2 size={12} strokeWidth={2.5} />
            <span>
              {worktreeBusy === "discard" ? t("running.discarding") : t("running.discardWorktree")}
            </span>
            </button>
          )}
        {!isActive &&
          task.status === "done" &&
          task.yunxiaoWorkitemId &&
          onOpenWriteback &&
          (task.yunxiaoWrittenBackAt ? (
            <button type="button" style={s.yunxiaoWritebackBtnDisabled} title={t("yunxiao.writeback.done")}>
              <CheckCircle2 size={12} strokeWidth={2.5} />
              <span>{t("yunxiao.writeback.done")}</span>
            </button>
          ) : (
            <button type="button" style={s.yunxiaoWritebackBtn} onClick={onOpenWriteback}>
              <Send size={12} strokeWidth={2.5} />
              <span>{t("yunxiao.writeback.button")}</span>
            </button>
          ))}
        {!isActive && (sessionPath || resumeSessionId || task.agent === "dsh") && (
          <SessionActionsMenu
            defaultForkName={defaultForkName}
            forkDisabledReason={forkDisabledReason}
            canExport={Boolean(sessionPath)}
            exporting={exporting}
            onFork={(name) => onFork?.(name)}
            onExport={handleExport}
          />
        )}
      </div>
      <div
        style={{
          padding: "4px 20px 12px",
          borderBottom: "1px solid var(--border-dim)",
          flexShrink: 0,
        }}
      >
        <div style={s.runMetaRow}>
          <span style={s.runMetaFixed}>
            {task.agent === "claude"
              ? "✦ Claude Code"
              : task.agent === "dsh"
                ? "⬡ DSH"
                : "⬡ Codex"}
            {task.agent !== "dsh" && (
              <> · {permissionModeLabel(task.permissionMode, task.agent)}</>
            )}
          </span>
          {ENABLE_USAGE_INSIGHTS && usageSnapshot && (task.agent === "claude"
            ? usageSnapshot.claude.status === "available" && (
                <>
                  {usageSnapshot.claude.data.fiveHour && (
                    <><span>·</span><InlineWindow label="5h" window={usageSnapshot.claude.data.fiveHour} /></>
                  )}
                  {usageSnapshot.claude.data.sevenDay && (
                    <><span>·</span><InlineWindow label="7d" window={usageSnapshot.claude.data.sevenDay} /></>
                  )}
                </>
              )
            : usageSnapshot.codex.status === "available" && (
                <>
                  {usageSnapshot.codex.data.primary && (
                    <><span>·</span><InlineWindow label="5h" window={usageSnapshot.codex.data.primary} /></>
                  )}
                  {usageSnapshot.codex.data.secondary && (
                    <><span>·</span><InlineWindow label="7d" window={usageSnapshot.codex.data.secondary} /></>
                  )}
                </>
              )
          )}
          {task.worktreePath && task.worktreeBranch && task.baseBranch && (
            <>
              <span style={s.runMetaFixed}>·</span>
              <span
                title={t("running.worktreeBranchTitle", {
                  branch: task.worktreeBranch,
                  base: task.baseBranch,
                })}
                style={s.runMetaBranchInline}
              >
                <GitBranch size={11} strokeWidth={2.2} />
                <span style={s.runMetaBranchText}>
                  {t("running.worktreeBranchInfo", {
                    branch: task.worktreeBranch,
                    base: task.baseBranch,
                  })}
                </span>
              </span>
            </>
          )}
        </div>
        {(metrics || sessionPath) && (
          <div style={s.runMetricsRow}>
            {metrics && (
              <>
                <MetricPill label={t("running.duration")} value={formatDuration(metrics.duration_secs)} />
                <MetricPill label={t("running.tokens")} value={formatTokens(metrics.total_tokens)} />
                {metrics.context_window > 0 && metrics.context_tokens > 0 && (
                  <MetricPill
                    label={t("running.context")}
                    value={`${formatTokens(metrics.context_tokens)} / ${formatTokens(metrics.context_window)} (${Math.round(
                      (metrics.context_tokens / metrics.context_window) * 100,
                    )}%)`}
                  />
                )}
              </>
            )}
            {sessionPath && (
              <SessionFilePill
                label={t("running.sessionFileLabel")}
                value={
                  currentMetricsState?.status === "ready" && metrics
                    ? formatFileSize(metrics.session_file_bytes)
                    : currentMetricsState?.status === "failed"
                      ? "0B"
                      : "..."
                }
                tone={
                  currentMetricsState?.status === "ready" && metrics
                    ? metrics.session_file_bytes > 0
                      ? "success"
                      : "error"
                    : currentMetricsState?.status === "failed"
                      ? "error"
                      : "warning"
                }
                copiedLabel={t("running.sessionFilePathCopied")}
                onCopy={handleCopySessionPath}
              />
            )}
          </div>
        )}
      </div>

      {/* Main content: terminal when active, session view when done/failed.
          structured 任务（codexStream 非空）渲染结构化流视图，不进终端红线链路。 */}
      {isDetached || isInterrupted ? (
        codexStream ? (
          <CodexStreamView
            entries={codexStream.entries}
            usage={codexStream.usage}
            history={codexStream.history}
            approval={null}
            onApprovalResolved={() => {}}
            running={false}
            statusText={t(
              isDetached
                ? "running.detachedTitle"
                : // structured 任务的 interrupted 常态来源是用户主动停止
                  //（/stop / ESC → turn/interrupt），不是进程异常退出。
                  codexStream
                  ? "running.interruptedStructuredTitle"
                  : "running.interruptedTitle",
            )}
            statusTone="warning"
            onOpenGitChanges={onOpenGitChanges}
            onOpenLink={onOpenLink}
            onComposerSubmit={onFollowUp}
            followUpBusy={followUpBusy}
            projectPath={projectPath}
            onImageToast={showToast}
            modelCatalog={codexModelCatalog}
            model={codexStructuredModel}
            reasoningEffort={codexStructuredEffort}
            showModelBadge={!!onSetStructuredModel}
            onSetStructuredModel={onSetStructuredModel}
            onBuiltinAction={onCodexBuiltinAction}
          />
        ) : (
        <div style={s.interruptedSessionWrap}>
          <div ref={interruptedBannerRef} style={s.interruptedBanner}>
            <div style={s.interruptedBannerIcon}>
              <AlertTriangle size={14} strokeWidth={2.1} />
            </div>
            <div style={s.interruptedBannerBody}>
              <div style={s.interruptedBannerTitle}>
                {t(isDetached ? "running.detachedTitle" : "running.interruptedTitle")}
              </div>
            </div>
            <div style={s.interruptedBannerActions}>
              <button
                type="button"
                title={!resumeAvailable ? t("running.resumeUnavailable") : undefined}
                style={{
                  ...s.interruptedPrimaryBtn,
                  opacity: resumeAvailable ? 1 : 0.45,
                  cursor: resumeAvailable ? "pointer" : "not-allowed",
                }}
                disabled={!resumeAvailable}
                onClick={isDetached ? onReconnect : onResume}
              >
                <RotateCcw size={12} strokeWidth={2.1} />
                <span>
                  {isDetached
                    ? bannerCompact
                      ? t("running.reconnect")
                      : t("running.reconnectTask")
                    : bannerCompact
                      ? t("running.resume")
                      : t("running.resumeTask")}
                </span>
              </button>
              {isInterrupted && (
                <button type="button" style={s.interruptedSecondaryBtn} onClick={onMarkDone}>
                  <CheckCircle2 size={12} strokeWidth={2.1} />
                  <span>{bannerCompact ? t("status.done") : t("running.markDone")}</span>
                </button>
              )}
              <button type="button" style={s.interruptedDangerBtn} onClick={onCancel}>
                <X size={12} strokeWidth={2.1} />
                <span>{bannerCompact ? t("running.cancel") : t("running.cancelTask")}</span>
              </button>
            </div>
          </div>
          {sessionPath ? (
            <SessionView sessionPath={sessionPath} />
          ) : (
            <div style={s.interruptedNoSessionPane}>
              {t(isDetached ? "running.detachedNoSession" : "running.interruptedNoSession")}
            </div>
          )}
        </div>
        )
      ) : isActive || !sessionPath ? (
        codexStream ? (
          <CodexStreamView
            entries={codexStream.entries}
            usage={codexStream.usage}
            history={codexStream.history}
            approval={codexStream.approval}
            onApprovalResolved={() => onCodexApprovalResolved?.()}
            userInput={codexStream.userInput}
            onUserInputResolved={() => onCodexUserInputResolved?.()}
            running={isActive}
            statusText={
              task.status === "failed"
                ? (task.failureReason ?? t("task.failed"))
                : task.status === "cancelled"
                  ? t("task.cancelled")
                  : undefined
            }
            statusTone={task.status === "failed" ? "error" : "warning"}
            onComposerSubmit={onFollowUp}
            followUpBusy={followUpBusy}
            projectPath={projectPath}
            onImageToast={showToast}
            onOpenGitChanges={onOpenGitChanges}
            onOpenLink={onOpenLink}
            composerDisabled={codexStream.approval !== null || codexStream.userInput !== null}
            modelCatalog={codexModelCatalog}
            model={codexStructuredModel}
            reasoningEffort={codexStructuredEffort}
            showModelBadge={!!onSetStructuredModel}
            onSetStructuredModel={onSetStructuredModel}
            onBuiltinAction={onCodexBuiltinAction}
          />
        ) : (
        <div style={s.terminalContainer}>
          <TerminalView
            key={`${task.id}-${runCount}`}
            onInput={onInput}
            onResize={onResize}
            onRegisterTerminal={onRegisterTerminal}
            onSavePastedImage={(dataUrl) =>
              invoke<string>("save_pasted_image", {
                projectPath,
                taskId: task.id,
                dataUrl,
              })
            }
            onReady={onTerminalReady}
            onSnapshot={onSnapshot}
            themeVariant={themeVariant}
            terminalFontSize={terminalFontSize}
            terminalScrollback={terminalScrollback}
            monoFontFamily={monoFontFamily}
            isActive={visible}
            agentActive={isActive}
            initialData={restoreState.initialData}
            initialSnapshot={restoreState.initialSnapshot}
          />
        </div>
        )
      ) : codexStream ? (
        // done/failed/cancelled 且有会话文件：structured 任务保持流视图 + composer
        // （Paseo 式会话框，继续对话不用换视图）；历史条目留在内存流里，
        // resume 通道只追加新一轮内容（thread/resume 不回放历史）。
        // 失败 / 取消态必须把原因交回横幅——这条分支早先没传 statusText，
        // 失败任务连一句提示都没有，看流尾像正常结束。
        <CodexStreamView
          entries={codexStream.entries}
          usage={codexStream.usage}
          history={codexStream.history}
          approval={null}
          onApprovalResolved={() => {}}
          running={false}
          statusText={
            task.status === "failed"
              ? (task.failureReason ?? t("task.failed"))
              : task.status === "cancelled"
                ? t("task.cancelled")
                : undefined
          }
          statusTone={task.status === "failed" ? "error" : "warning"}
          onComposerSubmit={onFollowUp}
          followUpBusy={followUpBusy}
          projectPath={projectPath}
          onImageToast={showToast}
          onOpenGitChanges={onOpenGitChanges}
          onOpenLink={onOpenLink}
          modelCatalog={codexModelCatalog}
          model={codexStructuredModel}
          reasoningEffort={codexStructuredEffort}
          showModelBadge={!!onSetStructuredModel}
          onSetStructuredModel={onSetStructuredModel}
          onBuiltinAction={onCodexBuiltinAction}
        />
      ) : (
        <SessionView sessionPath={sessionPath} />
      )}

      {/* Status bar when task is done and no session path (terminal fallback) */}
      {!isActive && !isDetached && !isInterrupted && !sessionPath && (
        <div
          style={{
            padding: "10px 20px",
            borderTop: "1px solid var(--border-dim)",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <StatusIcon status={task.status} />
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {task.status === "done"
              ? t("task.completed")
              : task.status === "failed"
                ? (task.failureReason ?? t("task.failed"))
                : t("task.cancelled")}
          </span>
        </div>
      )}
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div style={s.runMetricPill}>
      <span style={s.runMetricPillLabel}>{label}</span>
      <span style={s.runMetricPillValue}>{value}</span>
    </div>
  );
}

type SessionFilePillTone = "success" | "warning" | "error";

const sessionFilePillToneColor: Record<SessionFilePillTone, string> = {
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
};

function SessionFilePill({
  label,
  value,
  tone,
  copiedLabel,
  onCopy,
}: {
  label: string;
  value: string;
  tone: SessionFilePillTone;
  copiedLabel: string;
  onCopy: () => Promise<boolean>;
}) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const handleClick = async () => {
    const ok = await onCopy();
    if (!ok) return;
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1000);
  };

  return (
    <span
      style={s.runSessionFilePillWrap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        style={{ ...s.runMetricPill, ...s.runMetricPillButton }}
        onClick={handleClick}
      >
        <span
          aria-hidden="true"
          style={{
            ...s.railStatusDot,
            background: sessionFilePillToneColor[tone],
            borderColor: "var(--bg-input)",
            ...s.runSessionStatusDot,
          }}
        />
        <span style={s.runMetricPillLabel}>{label}</span>
        <span style={s.runMetricPillValue}>{value}</span>
      </button>
      {copied && hovered && <span style={s.runSessionCopyTooltip}>{copiedLabel}</span>}
    </span>
  );
}
