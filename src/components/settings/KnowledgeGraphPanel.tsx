import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as RadixDialog from "@radix-ui/react-dialog";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { Select } from "./Select";

interface KnowledgeGraph {
  id: string;
  name: string;
  adapter: string;
  ready: boolean;
  scanAvailable: boolean;
}

interface KnowledgeGraphAdapter {
  id: string;
  name: string;
}

interface KnowledgeCard {
  module: string;
  content: string;
  modified: boolean;
}

function relativePath(module: string) {
  return `data/modules/${module}.md`;
}

export function KnowledgeGraphPanel({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const [graphs, setGraphs] = useState<KnowledgeGraph[]>([]);
  const [adapters, setAdapters] = useState<KnowledgeGraphAdapter[]>([]);
  const [graphId, setGraphId] = useState("");
  const [newGraphId, setNewGraphId] = useState("");
  const [newGraphName, setNewGraphName] = useState("");
  const [adapter, setAdapter] = useState("his");
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [activeCard, setActiveCard] = useState("");
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [cardForm, setCardForm] = useState<{ mode: "create" | "rename"; value: string } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"overview" | "cards">("overview");

  const graph = graphs.find((item) => item.id === graphId);
  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? cards.filter((card) => card.module.toLowerCase().includes(query)) : cards;
  }, [cards, search]);

  const refresh = useCallback(async () => {
    const [nextGraphs, nextAdapters, config] = await Promise.all([
      invoke<KnowledgeGraph[]>("list_knowledge_targets"),
      invoke<KnowledgeGraphAdapter[]>("list_knowledge_graph_adapters"),
      invoke<{ knowledge?: { graph_id?: string } }>("read_project_config", { projectPath }),
    ]);
    setGraphs(nextGraphs);
    setAdapters(nextAdapters);
    setGraphId(config.knowledge?.graph_id ?? "");
  }, [projectPath]);

  useEffect(() => {
    refresh().catch((error) => setError(String(error)));
  }, [refresh]);

  useEffect(() => {
    if (!graphId) {
      setCards([]);
      return;
    }
    invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId })
      .then(setCards)
      .catch((error) => setError(String(error)));
  }, [graphId]);

  const bind = useCallback(async (nextId: string) => {
    setBusy(true);
    setError(null);
    try {
      const graph = await invoke<KnowledgeGraph>("bind_knowledge_graph", {
        projectPath,
        graphId: nextId,
      });
      setGraphId(graph.id);
      setStatus(t("settings.knowledgeBound", { name: graph.name }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [projectPath, t]);

  const create = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const graph = await invoke<KnowledgeGraph>("create_knowledge_graph", {
        projectPath,
        graphId: newGraphId,
        name: newGraphName,
        adapter,
      });
      await refresh();
      setGraphId(graph.id);
      setNewGraphId("");
      setNewGraphName("");
      setStatus(t("settings.knowledgeCreated", { name: graph.name }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [adapter, newGraphId, newGraphName, projectPath, refresh, t]);

  const scan = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("scan_knowledge_graph", { projectPath });
      const previousModules = new Set(cards.map((card) => card.module));
      const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId });
      const createdPaths = nextCards
        .filter((card) => !previousModules.has(card.module))
        .map((card) => relativePath(card.module));
      setPending((prev) => Array.from(new Set([...prev, "data/index.md", "data/graph.json", ...createdPaths])));
      setCards(nextCards);
      setStatus(t("settings.knowledgeScanDone"));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [cards, graphId, projectPath, t]);

  const initialize = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const graph = await invoke<KnowledgeGraph>("initialize_knowledge_graph", {
        projectPath,
        graphId,
      });
      setGraphs((prev) => prev.map((item) => item.id === graph.id ? { ...item, ready: graph.ready } : item));
      setStatus(t("settings.knowledgeInitialized", { name: graph.name }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [graphId, projectPath, t]);

  const openCard = useCallback((module: string) => {
    const card = cards.find((item) => item.module === module);
    if (!card) return;
    setActiveCard(module);
    setDraft(card.content);
  }, [cards]);

  const saveCard = useCallback(async () => {
    if (!activeCard || !graphId) return;
    setBusy(true);
    try {
      await invoke("save_knowledge_card", { graphId, module: activeCard, content: draft });
      setCards((prev) => prev.map((card) => card.module === activeCard ? { ...card, content: draft } : card));
      setPending((prev) => prev.includes(relativePath(activeCard)) ? prev : [...prev, relativePath(activeCard)]);
      setStatus(t("settings.knowledgeCardSaved", { module: activeCard }));
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [activeCard, draft, graphId, t]);

  const createCard = useCallback(async () => {
    const module = cardForm?.mode === "create" ? cardForm.value.trim() : "";
    if (!module) return;
    setBusy(true);
    try {
      const template = cards.find((card) => card.module === "_template")?.content ?? `# ${module}\n`;
      await invoke("save_knowledge_card", { graphId, module, content: template.split("<module>").join(module) });
    const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId });
      setCards(nextCards);
      setPending((prev) => [...prev, relativePath(module)]);
      openCard(module);
      setCardForm(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [cardForm, cards, graphId, openCard]);

  const renameCard = useCallback(async () => {
    const nextModule = cardForm?.mode === "rename" ? cardForm.value.trim() : "";
    if (!nextModule || nextModule === activeCard) return;
    setBusy(true);
    try {
      await invoke("rename_knowledge_card", { graphId, oldModule: activeCard, newModule: nextModule });
      const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId });
      setCards(nextCards);
      setPending((prev) => prev.map((path) => path === relativePath(activeCard) ? relativePath(nextModule) : path));
      setActiveCard(nextModule);
      setCardForm(null);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [activeCard, cardForm, graphId]);

  const deleteCard = useCallback(async () => {
    if (!activeCard) return;
    setBusy(true);
    try {
      await invoke("delete_knowledge_card", { graphId, module: activeCard });
      const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId });
      setCards(nextCards);
      setPending((prev) => prev.includes(relativePath(activeCard)) ? prev : [...prev, relativePath(activeCard)]);
      setActiveCard("");
      setDraft("");
      setDeleteOpen(false);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [activeCard, graphId]);

  const publish = useCallback(async () => {
    if (pending.length === 0) return;
    const label = graphId || t("settings.knowledge");
    setBusy(true);
    try {
      const result = await invoke<string>("publish_knowledge_changes", {
        graphId,
        paths: pending,
        message: `docs(knowledge): update ${label} graph`,
      });
      setPending([]);
      setStatus(result);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }, [graphId, pending, t]);

  return (
    mode === "cards" ? (
      <div className="knowledge-card-page">
        <button className="knowledge-breadcrumb" onClick={() => setMode("overview")}>
          ← {t("settings.knowledgeBackOverview")}
        </button>
        <div className="knowledge-toolbar">
          <input
            className="knowledge-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("settings.knowledgeSearchCards")}
          />
          <span className="knowledge-count">{cards.length}</span>
          <button className="knowledge-toolbar-btn" onClick={() => setCardForm({ mode: "create", value: "" })} disabled={busy || !graphId}>
            {t("settings.knowledgeCardCreate")}
          </button>
          <button className="knowledge-toolbar-btn" onClick={publish} disabled={busy || pending.length === 0}>
            {t("settings.knowledgePublish", { count: pending.length })}
          </button>
        </div>
        {status && <div style={s.modalLabelHint}>{status}</div>}
        <div className="knowledge-card-layout">
          <div className="knowledge-card-list">
            {cardForm?.mode === "create" && (
              <div className="knowledge-inline-form">
                <input aria-label={t("settings.knowledgeCardName")} style={s.modalInputFlex} value={cardForm.value} onChange={(event) => setCardForm({ mode: "create", value: event.target.value })} />
                <button type="button" style={s.modalSaveBtn} onClick={createCard} disabled={busy}>{t("common.create")}</button>
                <button type="button" style={s.modalCancelBtn} onClick={() => setCardForm(null)}>{t("common.cancel")}</button>
              </div>
            )}
            {visibleCards.map((card) => (
              <button
                key={card.module}
                type="button"
                className="knowledge-card-item"
                data-active={card.module === activeCard}
                onClick={() => openCard(card.module)}
              >
                {card.module}
              </button>
            ))}
          </div>
          <div className="knowledge-card-editor">
            {activeCard ? (
              <>
                <div className="knowledge-editor-toolbar">
                  <button type="button" style={s.modalSaveBtn} onClick={saveCard} disabled={busy}>{t("common.save")}</button>
                  <button type="button" style={s.modalCancelBtn} onClick={() => setCardForm({ mode: "rename", value: activeCard })} disabled={busy}>{t("common.rename")}</button>
                  <button type="button" style={s.modalCancelBtn} onClick={() => setDeleteOpen(true)} disabled={busy}>{t("common.delete")}</button>
                </div>
                {cardForm?.mode === "rename" && (
                  <div className="knowledge-inline-form">
                    <input aria-label={t("settings.knowledgeCardName")} style={s.modalInputFlex} value={cardForm.value} onChange={(event) => setCardForm({ mode: "rename", value: event.target.value })} />
                    <button type="button" style={s.modalSaveBtn} onClick={renameCard} disabled={busy}>{t("common.rename")}</button>
                    <button type="button" style={s.modalCancelBtn} onClick={() => setCardForm(null)}>{t("common.cancel")}</button>
                  </div>
                )}
                <textarea className="knowledge-card-source" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} />
                <RadixDialog.Root open={deleteOpen} onOpenChange={setDeleteOpen}>
                  <RadixDialog.Portal>
                    <RadixDialog.Overlay className="knowledge-dialog-overlay" />
                    <RadixDialog.Content className="knowledge-dialog">
                      <RadixDialog.Title>{t("settings.knowledgeCardDeleteTitle")}</RadixDialog.Title>
                      <RadixDialog.Description>{t("settings.knowledgeCardDeleteConfirm", { module: activeCard })}</RadixDialog.Description>
                      <div style={s.settingsFlexRow}>
                        <button type="button" style={s.modalCancelBtn} onClick={() => setDeleteOpen(false)}>{t("common.cancel")}</button>
                        <button type="button" style={s.modalSaveBtn} onClick={deleteCard}>{t("common.delete")}</button>
                      </div>
                    </RadixDialog.Content>
                  </RadixDialog.Portal>
                </RadixDialog.Root>
              </>
            ) : (
              <div className="knowledge-empty-editor">{t("settings.knowledgeCardSelect")}</div>
            )}
          </div>
        </div>
      </div>
    ) : (
      <div className="knowledge-overview">
        <div style={s.modalSection}>
          <div style={s.modalSectionTitle}>{t("settings.knowledgeBinding")}</div>
          <div style={s.modalField}>
            <label style={s.modalLabel}>{t("settings.knowledgeTarget")}</label>
            <Select
              value={graphId || "none"}
              onChange={(value) => value === "none"
                ? invoke("unbind_knowledge_graph", { projectPath }).then(() => setGraphId("")).catch((error) => setError(String(error)))
                : bind(value)}
              options={[
                { value: "none", label: t("settings.knowledgeTargetNone") },
                ...graphs.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
            <span style={s.modalLabelHint}>{t("settings.knowledgeTargetHint")}</span>
          </div>
        </div>

        {graph && (
          <div className="knowledge-summary">
            <div>
              <div className="knowledge-summary-title">{graph.name}</div>
              <div className="knowledge-summary-meta">
                {graph.ready ? t("settings.knowledgeReady") : t("settings.knowledgeNotReady")}
                {" · "}
                {graph.adapter}
              </div>
            </div>
            <div style={s.settingsFlexRow}>
              {!graph.ready && (
                <button type="button" style={s.modalSaveBtn} onClick={() => initialize().catch((error) => setError(String(error)))} disabled={busy}>
                  {t("settings.knowledgeInitialize")}
                </button>
              )}
              <button type="button" style={s.modalSaveBtn} onClick={scan} disabled={busy || !graph.ready || !graph.scanAvailable}>{t("settings.knowledgeScanAction")}</button>
              <button type="button" style={s.modalSaveBtn} onClick={() => setMode("cards")} disabled={!graph.ready}>
                {t("settings.knowledgeManageCards", { count: cards.length })}
              </button>
            </div>
          </div>
        )}

        <div style={s.modalSection}>
          <div style={s.modalSectionTitle}>{t("settings.knowledgeCreate")}</div>
          <div style={s.modalField}>
            <input style={s.modalInputFlex} value={newGraphId} onChange={(event) => setNewGraphId(event.target.value)} placeholder={t("settings.knowledgeGraphId")} />
            <input style={s.modalInputFlex} value={newGraphName} onChange={(event) => setNewGraphName(event.target.value)} placeholder={t("settings.knowledgeGraphName")} />
            <Select value={adapter} onChange={setAdapter} options={adapters.map((item) => ({ value: item.id, label: item.name }))} />
            <button type="button" style={s.modalSaveBtn} onClick={create} disabled={busy}>{t("settings.knowledgeCreateAction")}</button>
          </div>
        </div>
        {status && <div style={s.modalLabelHint}>{status}</div>}
        {error && <div style={s.settingsError}>{error}</div>}
      </div>
    )
  );
}
