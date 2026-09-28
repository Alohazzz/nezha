import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { useI18n } from "../../i18n";
import { rpRootStyle } from "../../styles/right-panel";
import type { KnowledgeSedimentationEvent } from "../../types";
import { YUNXIAO_KNOWLEDGE_BASE_PROJECT_ID } from "../../utils/yunxiao";
import { cardAbsPath } from "./knowledgeComments";
import { KnowledgeCardItem } from "./KnowledgeCardItem";
import { KnowledgeSedimentationResultDialog } from "../yunxiao/KnowledgeSedimentationResultDialog";

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

/** 发布分支需要的应用设置（云效凭据 + 知识沉淀开关）。 */
interface AppSettingsLite {
  knowledge?: { enabled?: boolean };
  yunxiao?: {
    token?: string;
    organizationId?: string;
    knowledgeBaseProjectId?: string;
  };
}

/** 云效「知识库图谱」议题的默认承载项目 id（与 App.tsx 复用同一常量）。 */

/** 组织「提交审批」议题的正文：列出待审核的模块卡片与操作指引。 */
function buildApprovalDescription(paths: string[], graphId: string): string {
  const modules = paths
    .map((p) => p.replace(/^data\/modules\//, "").replace(/\.md$/, ""))
    .map((m) => `- ${m}`)
    .join("\n");
  return [
    `图谱：${graphId || "（未知）"}`,
    "",
    "以下模块卡片有新的知识待审核入库：",
    "",
    modules,
    "",
    "审核方式：在知识库仓库对应卡片中确认条目的依据与正确性，通过后由负责人提交并推送；",
    "如需修改或丢弃，直接在卡片中编辑或还原未提交内容即可。",
  ].join("\n");
}

/**
 * 右侧工具条「知识库」面板：展示当前项目绑定图谱的模块卡片列表。
 * 点卡片即在主窗体打开对应 md（可编辑，预览态高亮未发布的新增条目）。
 *
 * 回写统一在此审核：`提交并推送`（确认发布）/ `全部丢弃`（还原工作区）。
 * 发布分支由应用设置「知识沉淀」开关决定——开启直接提交推送图谱，关闭改建议题走云效审批。
 */
export function KnowledgePanel({
  projectPath,
  onOpenCard,
  width = 280,
}: {
  projectPath: string;
  /** 点击卡片：在主窗体以 Markdown 打开对应卡片文件。 */
  onOpenCard: (module: string, absPath: string, graphId: string) => void;
  width?: number;
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
  // 最近一次沉淀判定明细（写入 / 拒绝与逐条理由），由 `knowledge-sedimentation` 事件填充。
  const [lastVerdict, setLastVerdict] = useState<KnowledgeSedimentationEvent | null>(null);
  const [showVerdict, setShowVerdict] = useState(false);

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

  // 技能仓库（图谱数据所在）被后台同步或写入后自动刷新：
  // 后端在定时拉取 / 提交推送后会 emit `skill-hub-changed`，此前只有 SkillHubView 监听，
  // 导致打开着的知识面板会一直显示旧卡片（读到「最新图谱」在 UI 上落空）。
  useEffect(() => {
    // `listen` 在非 Tauri 环境（如单测未 mock 事件模块）会 reject；这里吞掉即可：
    // 刷新只是锦上添花，拿不到事件不应影响面板可用性，更不能产生未处理的 rejection。
    const unlisten = listen("skill-hub-changed", () => {
      refresh().catch((e) => setError(String(e)));
    }).catch(() => null);
    return () => {
      unlisten.then((fn) => fn?.());
    };
  }, [refresh]);

  // 沉淀判定完成后：记住最近一次明细（供「最近一次判定结果」入口），并立刻刷新脏卡列表
  // （暂存内容已落工作区，红点与徽标要同步更新）。
  useEffect(() => {
    const unlisten = listen<KnowledgeSedimentationEvent>("knowledge-sedimentation", (event) => {
      const payload = event.payload;
      if (payload.status === "running") return;
      setLastVerdict(payload);
      refresh().catch((e) => setError(String(e)));
    }).catch(() => null);
    return () => {
      unlisten.then((fn) => fn?.());
    };
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

      // 发布分支由「知识沉淀」开关决定：开启 = 直接落库；关闭 = 走云效审批。
      const settings = await invoke<AppSettingsLite>("load_app_settings");
      const autoWrite = settings.knowledge?.enabled ?? true;
      if (autoWrite) {
        await invoke<string>("publish_knowledge_changes", {
          graphId,
          paths: currentPaths,
          message: `docs(knowledge): update ${label} graph`,
        });
        setPending([]);
        setStatus(t("knowledgePanel.publishDone"));
        await refresh();
        return;
      }

      // 关闭自动写入：创建云效审核议题，交由人工审核后更新图谱（不由本机推送）。
      const yunxiao = settings.yunxiao ?? {};
      if (!yunxiao.token || !yunxiao.organizationId) {
        setError(t("knowledgePanel.needYunxiaoForApproval"));
        return;
      }
      await invoke("yunxiao_create_knowledge_issue", {
        token: yunxiao.token,
        organizationId: yunxiao.organizationId,
        projectId: yunxiao.knowledgeBaseProjectId ?? YUNXIAO_KNOWLEDGE_BASE_PROJECT_ID,
        subject: t("knowledgePanel.approvalSubject", { graph: label }),
        description: buildApprovalDescription(currentPaths, graphId),
      });
      setStatus(t("knowledgePanel.approvalCreated", { count: currentPaths.length }));
      // 已提交审批：丢弃本地未发布改动，避免重复提交（内容已随议题留痕）。
      await invoke<number>("discard_knowledge_changes", { graphId });
      setPending([]);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [graphId, t, refresh]);

  /** 「全部丢弃」：还原图谱仓库工作区里所有未提交改动（含自动沉淀暂存与人工编辑）。 */
  const discard = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus("");
    try {
      const discarded = await invoke<number>("discard_knowledge_changes", { graphId });
      setPending([]);
      setStatus(t("knowledgePanel.discardDone", { count: discarded }));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [graphId, t, refresh]);

  return (
    <div className="rp-root" style={rpRootStyle(width)}>
      <div className="rp-header">
        <div className="rp-titlebar">
          <span className="rp-title">{t("knowledgePanel.title")}</span>
          <span className="rp-count-chip">{cards.length}</span>
          <button
            type="button"
            className="rp-icon-btn"
            onClick={() => void refresh()}
            disabled={busy}
            title={t("common.refresh")}
          >
            <RefreshCw size={13} className={busy ? "rp-spin" : undefined} />
          </button>
          <button
            type="button"
            className="rp-text-btn"
            data-variant={pending.length > 0 ? "primary" : undefined}
            onClick={() => void publish()}
            disabled={busy || pending.length === 0}
          >
            {busy && <Loader2 size={11} className="rp-spin" />}
            {t("knowledgePanel.publish", { count: pending.length })}
          </button>
          <button
            type="button"
            className="rp-text-btn"
            onClick={() => void discard()}
            disabled={busy || pending.length === 0}
            title={t("knowledgePanel.discardHint")}
          >
            {t("knowledgePanel.discard")}
          </button>
        </div>
        <div className="rp-toolbar-row">
          <div className="rp-search-box">
            <Search size={12} className="rp-search-icon" />
            <input
              className="rp-search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("knowledgePanel.searchCards")}
            />
          </div>
          {lastVerdict && (
            <button
              type="button"
              className="rp-text-btn"
              onClick={() => setShowVerdict(true)}
              title={t("yunxiao.knowledge.resultButton")}
            >
              {t("yunxiao.knowledge.resultButton")}
            </button>
          )}
        </div>
      </div>

      {status && <div className="rp-info">{status}</div>}
      {error && <div className="rp-error">{error}</div>}

      {!target || !target.ready ? (
        <div className="rp-empty">{t("knowledgePanel.noGraphBound")}</div>
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
            <div className="rp-empty">{t("knowledgePanel.selectCard")}</div>
          )}
        </div>
      )}

      {showVerdict && lastVerdict && (
        <KnowledgeSedimentationResultDialog
          result={lastVerdict}
          onClose={() => setShowVerdict(false)}
        />
      )}
    </div>
  );
}
