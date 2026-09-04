import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import { cardAbsPath } from "./knowledgeComments";
import { KnowledgeCardItem } from "./KnowledgeCardItem";

interface KnowledgeGraphTarget {
  id: string;
  name: string;
  adapter: string;
  graphDir: string;
  skillDir: string;
  dataDir: string;
  ready: boolean;
  scanAvailable: boolean;
}

interface KnowledgeCard {
  module: string;
  content: string;
  modified: boolean;
}

/**
 * 右侧工具条「知识库」面板：展示当前项目绑定图谱的模块卡片列表。
 * 点卡片即在主窗体打开对应 md（可编辑）；「提交并推送」发布知识库仓库里已修改的卡片。
 */
export function KnowledgePanel({
  projectPath,
  onOpenCard,
}: {
  projectPath: string;
  /** 点击卡片：在主窗体以 Markdown 打开对应卡片文件。 */
  onOpenCard: (module: string, absPath: string, graphId: string) => void;
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

  const visibleCards = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? cards.filter((card) => card.module.toLowerCase().includes(query)) : cards;
  }, [cards, search]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await invoke<{ knowledge?: { graph_id?: string } }>("read_project_config", {
        projectPath,
      });
      const gid = config.knowledge?.graph_id ?? "";
      setGraphId(gid);
      const nextTargets = await invoke<KnowledgeGraphTarget[]>("list_knowledge_targets");
      const found = nextTargets.find((item) => item.id === gid) ?? null;
      setTarget(found);
      if (gid && found) {
        const nextCards = await invoke<KnowledgeCard[]>("list_knowledge_cards", { graphId: gid });
        setCards(nextCards);
        const modified = await invoke<string[]>("list_modified_knowledge_cards", { graphId: gid });
        setPending(modified.map((module) => `data/modules/${module}.md`));
      } else {
        setCards([]);
        setPending([]);
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

  const publish = useCallback(async () => {
    // 始终先查最新脏卡片，避免面板 state 过期导致误判「无变更」。
    const label = graphId || t("knowledgePanel.title");
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const modified = await invoke<string[]>("list_modified_knowledge_cards", { graphId });
      const currentPaths = modified.map((module) => `data/modules/${module}.md`);
      setPending(currentPaths);
      if (currentPaths.length === 0) {
        setStatus(t("knowledgePanel.noChanges"));
        return;
      }
      await invoke<string>("publish_knowledge_changes", {
        graphId,
        paths: currentPaths,
        message: `docs(knowledge): update ${label} graph`,
      });
      setPending([]);
      setStatus(t("knowledgePanel.publishDone"));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [graphId, t, refresh]);

  return (
    <div className="kpanel">
      <div className="kpanel-toolbar">
        <div className="kpanel-toolbar-search">
          <input
            className="knowledge-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("knowledgePanel.searchCards")}
          />
          <span className="knowledge-count">{cards.length}</span>
        </div>
        <div className="kpanel-toolbar-actions">
          <button className="knowledge-toolbar-btn" onClick={() => void refresh()} disabled={busy}>
            {t("common.refresh")}
          </button>
          <button
            className="knowledge-toolbar-btn"
            onClick={() => void publish()}
            disabled={busy}
          >
            {t("knowledgePanel.publish", { count: pending.length })}
          </button>
        </div>
      </div>

      {status && <div className="kpanel-status">{status}</div>}
      {error && <div className="kpanel-error">{error}</div>}

      {!target || !target.ready ? (
        <div className="kpanel-empty">{t("knowledgePanel.noGraphBound")}</div>
      ) : (
        <div className="kpanel-list">
          {visibleCards.map((card) => (
            <KnowledgeCardItem
              key={card.module}
              module={card.module}
              active={card.module === activeModule}
              modified={pending.includes(`data/modules/${card.module}.md`)}
              onClick={() => {
                setActiveModule(card.module);
                onOpenCard(
                  card.module,
                  cardAbsPath(target ? target.dataDir : "", card.module),
                  target ? target.id : "",
                );
              }}
            />
          ))}
          {visibleCards.length === 0 && (
            <div className="kpanel-empty-editor">{t("knowledgePanel.selectCard")}</div>
          )}
        </div>
      )}
    </div>
  );
}
