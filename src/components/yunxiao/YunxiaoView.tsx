import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, Loader2, RefreshCw, Search, Settings } from "lucide-react";
import type {
  Project,
  Task,
  YunxiaoOrganization,
  YunxiaoPage,
  YunxiaoProject,
  YunxiaoWorkitem,
} from "../../types";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import { buildYunxiaoTaskName, isYunxiaoWorkitemImported } from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import { SelectField } from "./SelectField";
import { YunxiaoConnectForm } from "./YunxiaoConnectForm";
import { YunxiaoIssueList } from "./YunxiaoIssueList";
import s from "../../styles";

const PAGE_SIZE = 100;
const YUNXIAO_LAST_PROJECT_KEY = "nezha:yunxiaoLastProjectId";

type CategoryKey = "all" | "Req" | "Task" | "Bug";

const CATEGORIES: Array<{ key: CategoryKey; labelKey: string }> = [
  { key: "all", labelKey: "yunxiao.categoryAll" },
  { key: "Req", labelKey: "yunxiao.categoryReq" },
  { key: "Task", labelKey: "yunxiao.categoryTask" },
  { key: "Bug", labelKey: "yunxiao.categoryBug" },
];

export function YunxiaoView({
  projects,
  tasks,
  onBack,
  onImportIssue,
}: {
  projects: Project[];
  tasks: Task[];
  onBack: () => void;
  onImportIssue: (issue: YunxiaoWorkitem, targetProjectId: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();

  const [settings, setSettings] = useState<YunxiaoSettings>(EMPTY_YUNXIAO_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connectMode, setConnectMode] = useState(false);

  // 连接表单
  const [tokenInput, setTokenInput] = useState("");
  const [organizations, setOrganizations] = useState<YunxiaoOrganization[]>([]);
  const [organizationLoading, setOrganizationLoading] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [cloudProjects, setCloudProjects] = useState<YunxiaoProject[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saving, setSaving] = useState(false);

  // 议题列表
  const [category, setCategory] = useState<CategoryKey>("all");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<YunxiaoWorkitem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState("");

  const configured = !!(settings.token && settings.organizationId && settings.projectId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const appSettings = await invoke<AppSettings>("load_app_settings");
        if (cancelled) return;
        const yunxiao = appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS;
        setSettings(yunxiao);
        setTokenInput(yunxiao.token);
        setSelectedOrgId(yunxiao.organizationId);
        setSelectedProjectId(yunxiao.projectId);
      } catch (e) {
        console.error("[yunxiao] load_app_settings failed:", e);
      } finally {
        if (!cancelled) setSettingsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 默认导入目标：记住上次选择，否则取第一个本地项目。
  useEffect(() => {
    if (targetProjectId) return;
    const stored = localStorage.getItem(YUNXIAO_LAST_PROJECT_KEY);
    if (stored && projects.some((p) => p.id === stored)) {
      setTargetProjectId(stored);
    } else if (projects.length > 0) {
      setTargetProjectId(projects[0].id);
    }
  }, [projects, targetProjectId]);

  const loadIssues = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!settings.token || !settings.organizationId || !settings.projectId) return;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const result = await invoke<YunxiaoPage<YunxiaoWorkitem>>("yunxiao_search_workitems", {
          token: settings.token,
          organizationId: settings.organizationId,
          projectId: settings.projectId,
          category: category === "all" ? undefined : category,
          page: nextPage,
          perPage: PAGE_SIZE,
        });
        setIssues((prev) => (append ? [...prev, ...result.items] : result.items));
        setTotal(result.total);
        setPage(result.page);
      } catch (e) {
        showToast(t("yunxiao.loadFailed", { error: String(e) }), "error");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [settings.token, settings.organizationId, settings.projectId, category, showToast, t],
  );

  useEffect(() => {
    if (!configured || connectMode || !settingsLoaded) return;
    setIssues([]);
    setTotal(0);
    setPage(0);
    loadIssues(1, false);
  }, [configured, connectMode, settingsLoaded, category, loadIssues]);

  const importedIds = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((task) => {
      if (task.yunxiaoWorkitemId) set.add(task.yunxiaoWorkitemId);
    });
    return set;
  }, [tasks]);

  const filteredIssues = useMemo(() => {
    if (!query.trim()) return issues;
    const q = query.toLowerCase();
    return issues.filter(
      (issue) =>
        issue.subject.toLowerCase().includes(q) ||
        issue.serialNumber.toLowerCase().includes(q),
    );
  }, [issues, query]);

  async function handleFetchOrganizations() {
    const token = tokenInput.trim();
    if (!token) {
      showToast(t("yunxiao.tokenRequired"), "warning");
      return;
    }
    setOrganizationLoading(true);
    try {
      const orgs = await invoke<YunxiaoOrganization[]>("yunxiao_list_organizations", { token });
      setOrganizations(orgs);
      if (orgs.length === 1) {
        setSelectedOrgId(orgs[0].id);
        await handleFetchProjects(token, orgs[0].id);
      }
    } catch (e) {
      showToast(t("yunxiao.fetchOrganizationsFailed", { error: String(e) }), "error");
    } finally {
      setOrganizationLoading(false);
    }
  }

  async function handleFetchProjects(tokenArg?: string, orgIdArg?: string) {
    const token = tokenArg ?? tokenInput.trim();
    const orgId = orgIdArg ?? selectedOrgId;
    if (!token || !orgId) {
      showToast(t("yunxiao.selectOrganization"), "warning");
      return;
    }
    setProjectLoading(true);
    try {
      const result = await invoke<YunxiaoPage<YunxiaoProject>>("yunxiao_search_projects", {
        token,
        organizationId: orgId,
        page: 1,
        perPage: 200,
      });
      setCloudProjects(result.items);
      if (!selectedProjectId && result.items.length > 0) {
        setSelectedProjectId(result.items[0].id);
      }
    } catch (e) {
      showToast(t("yunxiao.loadProjectsFailed", { error: String(e) }), "error");
    } finally {
      setProjectLoading(false);
    }
  }

  async function handleSaveConnection() {
    if (!tokenInput.trim() || !selectedOrgId || !selectedProjectId) {
      showToast(t("yunxiao.tokenRequired"), "warning");
      return;
    }
    const org = organizations.find((o) => o.id === selectedOrgId);
    const proj = cloudProjects.find((p) => p.id === selectedProjectId);
    setSaving(true);
    try {
      const appSettings = await invoke<AppSettings>("save_yunxiao_settings", {
        token: tokenInput.trim(),
        organizationId: selectedOrgId,
        organizationName: org?.name,
        projectId: selectedProjectId,
        projectName: proj?.name,
      });
      setSettings(appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS);
      setConnectMode(false);
      showToast(t("yunxiao.connected"));
    } catch (e) {
      showToast(t("yunxiao.saveFailed", { error: String(e) }), "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleImport(issue: YunxiaoWorkitem) {
    if (isYunxiaoWorkitemImported(tasks, issue.id)) {
      showToast(t("yunxiao.importDuplicate"), "warning");
      return;
    }
    if (!targetProjectId) {
      showToast(t("yunxiao.targetProjectRequired"), "warning");
      return;
    }
    const ok = await onImportIssue(issue, targetProjectId);
    if (ok) {
      localStorage.setItem(YUNXIAO_LAST_PROJECT_KEY, targetProjectId);
      showToast(t("yunxiao.importSuccess", { name: buildYunxiaoTaskName(issue) }));
    }
  }

  const [backHover, setBackHover] = useState(false);
  const [refreshHover, setRefreshHover] = useState(false);
  const [settingsHover, setSettingsHover] = useState(false);
  const targetOptions = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <div style={s.yunxiaoPane}>
      <div style={s.yunxiaoHeader}>
        <button
          type="button"
          style={backHover ? s.yunxiaoBackBtnHover : s.yunxiaoBackBtn}
          onClick={onBack}
          title={t("yunxiao.back")}
          aria-label={t("yunxiao.back")}
          onMouseEnter={() => setBackHover(true)}
          onMouseLeave={() => setBackHover(false)}
        >
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <div>
          <div style={s.yunxiaoHeaderTitle}>{t("yunxiao.title")}</div>
          <div style={s.yunxiaoHeaderMeta}>
            {configured
              ? `${settings.organizationName ?? settings.organizationId} · ${settings.projectName ?? settings.projectId}`
              : t("yunxiao.notConnected")}
          </div>
        </div>
        <div style={s.yunxiaoHeaderActions}>
          {configured && (
            <button
              type="button"
              style={refreshHover ? s.yunxiaoToolbarBtnHover : s.yunxiaoToolbarBtn}
              onClick={() => loadIssues(1, false)}
              title={t("yunxiao.refresh")}
              aria-label={t("yunxiao.refresh")}
              onMouseEnter={() => setRefreshHover(true)}
              onMouseLeave={() => setRefreshHover(false)}
            >
              {loading ? (
                <Loader2 size={13} strokeWidth={2} className="spin" />
              ) : (
                <RefreshCw size={13} strokeWidth={2} />
              )}
            </button>
          )}
          <button
            type="button"
            style={settingsHover ? s.yunxiaoToolbarBtnHover : s.yunxiaoToolbarBtn}
            onClick={() => setConnectMode(true)}
            title={t("yunxiao.reconnect")}
            aria-label={t("yunxiao.reconnect")}
            onMouseEnter={() => setSettingsHover(true)}
            onMouseLeave={() => setSettingsHover(false)}
          >
            <Settings size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {connectMode || !configured ? (
        <YunxiaoConnectForm
          tokenInput={tokenInput}
          onTokenChange={setTokenInput}
          organizations={organizations}
          selectedOrgId={selectedOrgId}
          onOrgChange={setSelectedOrgId}
          cloudProjects={cloudProjects}
          selectedProjectId={selectedProjectId}
          onProjectChange={setSelectedProjectId}
          organizationLoading={organizationLoading}
          projectLoading={projectLoading}
          saving={saving}
          onFetchOrganizations={handleFetchOrganizations}
          onFetchProjects={handleFetchProjects}
          onSave={handleSaveConnection}
        />
      ) : (
        <>
          <div style={s.yunxiaoToolbar}>
            <div style={s.yunxiaoTabs}>
              {CATEGORIES.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  style={category === c.key ? s.yunxiaoTabActive : s.yunxiaoTab}
                  onClick={() => setCategory(c.key)}
                >
                  {t(c.labelKey)}
                </button>
              ))}
            </div>
            <div style={s.yunxiaoSearchBox}>
              <Search size={13} strokeWidth={2} color="var(--text-muted)" />
              <input
                style={s.yunxiaoSearchInput}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("yunxiao.searchPlaceholder")}
              />
            </div>
            <div style={s.yunxiaoCount}>{t("yunxiao.count", { count: total })}</div>
          </div>
          <div style={s.yunxiaoToolbar}>
            <label style={s.yunxiaoFieldLabel}>{t("yunxiao.importToProject")}</label>
            <SelectField
              value={targetProjectId}
              onChange={setTargetProjectId}
              options={targetOptions}
              placeholder={t("yunxiao.selectProject")}
            />
          </div>
          <YunxiaoIssueList
            issues={filteredIssues}
            total={total}
            loading={loading}
            loadingMore={loadingMore}
            importedIds={importedIds}
            onImport={handleImport}
            onLoadMore={() => loadIssues(page + 1, true)}
          />
        </>
      )}
    </div>
  );
}