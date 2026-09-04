import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import type { AgentType, PermissionMode, Task } from "../../types";
import { renderMarkdownWithToc } from "../../utils/markdown";
import { CommentSendDialog, type SendMode } from "../file-viewer/CommentSendDialog";
import { resolveTargetTask } from "../file-viewer/reviewComments";
import {
  cardAbsPath,
  buildKnowledgeBatchMessage,
  newKnowledgeCommentId,
  type KnowledgeComment,
} from "./knowledgeComments";

interface KnowledgeGraphTarget {
  id: string;
  name: string;
  adapter: string;
  graph_dir: string;
  skill_dir: string;
  data_dir: string;
  ready: boolean;
  scan_available: boolean;
}

interface KnowledgeCard {
  module: string;
  content: string;
  modified: boolean;
}

type TaskSubmitArgs = {
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
  repoPath: string;
};

export function KnowledgePanel({
  projectPath,
  projectTasks,
  repoPath,
  onInput,
  onResumeTaskAndSend,
  onSubmitTask,
  showToast,
}: {
  projectPath: string;
  projectTasks: Task[];
  repoPath: string;
  onInput: (taskId: string, input: string) => void;
  onResumeTaskAndSend: (taskId: string, input: string) => void;
  onSubmitTask: (t: TaskSubmitArgs) => void;
  showToast: (message: string, type?: "error" | "warning" | "success") => void;
}) {
  const { t } = useI18n();
  const [graphId, setGraphId] = useState("");
  const [target, setTarget] = useState<KnowledgeGraphTarget | null>(null);
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [activeModule, setActiveModule] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [modifyComposer, setModifyComposer] = useState<{ module: string; text: string } | null>(
    null,
  );
  const [sendState, setSendState] = useState<{ comments: KnowledgeComment[] } | null>(null);
  const [defaultAgent, setDefaultAgent] = useState<AgentType>("claude");

  const activeCard = useMemo(
    () => cards.find((card) => card.module === activeModule) ?? null,
    [cards, activeModule],
  );

  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? cards.filter((card) => card.module.toLowerCase().includes(query)) : cards;
  }, [cards, search]);

  const previewHtml = useMemo(
    () => (activeCard ? renderMarkdownWithToc(activeCard.content).html : ""),
    [activeCard],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await invoke<{
        knowledge?: { graph_id?: string };
        agent?: { default?: string };
      }>("read_project_config", { projectPath });
      const gid = config.knowledge?.graph_id ?? "";
      setGraphId(gid);
      // 知识库跨仓库写入依赖 claude/codex 的权限旗标；dsh 无对应处理时回退 claude。
      const rawAgent = (config.agent?.default ?? "") as AgentType;
      setDefaultAgent(rawAgent === "claude" || rawAgent === "codex" ? rawAgent : "claude");
      const nextTargets = await invoke<KnowledgeGraphTarget[]>("list_knowledge_targets");
      const found = nextTargets.find((item) => item.id === gid) ?? null;
      setTarget(found);
      if (gid && found) {
        const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId: gid });
        setCards(nextCards);
      } else {
        setCards([]);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectPath]);

  useEffect(() => {
    refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  const addToPending = useCallback((modules: string[]) => {
    setPending((prev) =>
      Array.from(new Set([...prev, ...modules.map((module) => `data/modules/${module}.md`)])),
    );
  }, []);

  const markSent = useCallback(
    (comments: KnowledgeComment[]) => {
      addToPending(comments.map((comment) => comment.module));
    },
    [addToPending],
  );

  const submitModify = useCallback(() => {
    if (!modifyComposer || !target || !target.ready) return;
    const text = modifyComposer.text.trim();
    if (!text) return;
    const comment: KnowledgeComment = {
      id: newKnowledgeCommentId(),
      module: modifyComposer.module,
      absPath: cardAbsPath(target.data_dir, modifyComposer.module),
      text,
      status: "open",
      createdAt: Date.now(),
    };
    const comments = [comment];
    setModifyComposer(null);

    if (projectTasks.length === 0) {
      // 无父任务：直接作为新任务发（full_access，跨仓库写）。
      const message = buildKnowledgeBatchMessage(comments);
      onSubmitTask({
        prompt: message,
        agent: defaultAgent,
        permissionMode: "full_access",
        images: [],
        texts: [],
        immediate: true,
        launchMode: "local",
        baseBranch: "",
        repoPath,
      });
      markSent(comments);
      showToast(t("knowledgePanel.sentToNewTask"), "success");
      return;
    }

    setSendState({ comments });
  }, [
    modifyComposer,
    target,
    projectTasks,
    defaultAgent,
    onSubmitTask,
    repoPath,
    markSent,
    showToast,
    t,
  ]);

  const handleSendDialogSend = useCallback(
    (taskId: string, mode: SendMode) => {
      if (!sendState) return;
      const task = projectTasks.find((candidate) => candidate.id === taskId);
      if (!task) return;
      const comments = sendState.comments;
      if (comments.length === 0) return;
      const message = buildKnowledgeBatchMessage(comments);

      if (mode === "direct") {
        if (task.permissionMode !== "full_access") {
          showToast(t("knowledgePanel.permWarning"), "warning");
          return;
        }
        onInput(task.id, `${message}\r`);
      } else if (mode === "resume") {
        if (task.permissionMode !== "full_access") {
          showToast(t("knowledgePanel.permWarning"), "warning");
          return;
        }
        onResumeTaskAndSend(task.id, `${message}\r`);
      } else {
        // 作为新任务发：强制 full_access（跨仓库写），不继承父任务 prompt。
        onSubmitTask({
          prompt: message,
          agent: task.agent,
          permissionMode: "full_access",
          model: task.model,
          reasoningEffort: task.reasoningEffort,
          images: [],
          texts: [],
          immediate: true,
          launchMode: "local",
          baseBranch: "",
          repoPath,
        });
      }
      markSent(comments);
      setSendState(null);
      showToast(t("reviewComments.sentToast", { count: comments.length, name: task.name ?? task.id }), "success");
    },
    [sendState, projectTasks, onInput, onResumeTaskAndSend, onSubmitTask, repoPath, markSent, showToast, t],
  );

  const publish = useCallback(async () => {
    if (pending.length === 0) return;
    const label = graphId || t("knowledgePanel.title");
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<string>("publish_knowledge_changes", {
        graphId,
        paths: pending,
        message: `docs(knowledge): update ${label} graph`,
      });
      setPending([]);
      setStatus(result);
      showToast(result, "success");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [pending, graphId, t, showToast]);

  const openModify = useCallback((module: string) => {
    setModifyComposer({ module, text: "" });
  }, []);

  return (
    <div className="kpanel">
      <div className="kpanel-toolbar">
        <input
          className="knowledge-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("knowledgePanel.searchCards")}
        />
        <span className="knowledge-count">{cards.length}</span>
        <button className="knowledge-toolbar-btn" onClick={() => void refresh()} disabled={busy}>
          {t("common.refresh")}
        </button>
        <button className="knowledge-toolbar-btn" onClick={() => void publish()} disabled={busy || pending.length === 0}>
          {t("knowledgePanel.publish", { count: pending.length })}
        </button>
      </div>

      {status && <div className="kpanel-status">{status}</div>}
      {error && <div className="kpanel-error">{error}</div>}

      {!target || !target.ready ? (
        <div className="kpanel-empty">{t("knowledgePanel.noGraphBound")}</div>
      ) : (
        <div className="kpanel-body">
          <div className="kpanel-list">
            {visibleCards.map((card) => (
              <button
                key={card.module}
                type="button"
                className="knowledge-card-item"
                data-active={card.module === activeModule}
                onClick={() => setActiveModule(card.module)}
              >
                {card.module}
              </button>
            ))}
          </div>
          <div className="kpanel-preview">
            {activeCard ? (
              <>
                <div className="kpanel-preview-head">
                  <strong>{activeCard.module}</strong>
                  <button className="knowledge-toolbar-btn" onClick={() => openModify(activeCard.module)}>
                    {t("knowledgePanel.modify")}
                  </button>
                </div>
                <div
                  className="kpanel-preview-body md-preview"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </>
            ) : (
              <div className="kpanel-empty-editor">{t("knowledgePanel.selectCard")}</div>
            )}
          </div>
        </div>
      )}

      {modifyComposer && target && (
        <div className="kpanel-modify">
          <div className="kpanel-modify-head">
            {t("knowledgePanel.modifyTitle", { module: modifyComposer.module })}
          </div>
          <textarea
            className="knowledge-card-source"
            value={modifyComposer.text}
            onChange={(event) => setModifyComposer({ module: modifyComposer.module, text: event.target.value })}
            placeholder={t("knowledgePanel.modifyPlaceholder")}
            spellCheck={false}
          />
          <div className="kpanel-modify-actions">
            <button className="kpanel-secondary-btn" onClick={() => setModifyComposer(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="knowledge-toolbar-btn"
              onClick={submitModify}
              disabled={busy || !modifyComposer.text.trim()}
            >
              {t("knowledgePanel.sendToAgent")}
            </button>
          </div>
        </div>
      )}

      {sendState && (
        <CommentSendDialog
          comments={sendState.comments}
          labelFor={(comment) => comment.module}
          tasks={projectTasks}
          defaultTaskId={resolveTargetTask(projectTasks)?.id ?? null}
          allowNewTask
          onClose={() => setSendState(null)}
          onSend={handleSendDialogSend}
        />
      )}
    </div>
  );
}
