import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
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
import { YunxiaoHeader } from "./YunxiaoHeader";
import { YunxiaoFilterBar } from "./YunxiaoFilterBar";
import { YunxiaoImportBar } from "./YunxiaoImportBar";
import { useYunxiaoFilters } from "./useYunxiaoFilters";
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

  // 过滤状态（搜索/我负责的/状态多选/当前用户/持久化）下沉到 hook。
  const statusCategories = useMemo(
    () => (category === "all" ? ["Req", "Task", "Bug"] : [category]),
    [category],
  );
  const filters = useYunxiaoFilters(
    settings,
    configured && !connectMode,
    statusCategories,
    setSettings,
  );
  const { conditions } = filters;

  const loadIssues = useCallback(
    async (nextPage: number, append: boolean) => {
      if (!settings.token || !settings.organizationId || !settings.projectId) return;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      try {
        const args: Record<string, unknown> = {
          token: settings.token,
          organizationId: settings.organizationId,
          projectId: settings.projectId,
          category: category === "all" ? undefined : category,
          page: nextPage,
          perPage: PAGE_SIZE,
        };
        if (conditions) args.conditions = conditions;
        const result = await invoke<YunxiaoPage<YunxiaoWorkitem>>(
          "yunxiao_search_workitems",
          args,
        );
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
    [
      settings.token,
      settings.organizationId,
      settings.projectId,
      category,
      conditions,
      showToast,
      t,
    ],
  );

  useEffect(() => {
    if (!configured || connectMode || !settingsLoaded) return;
    setIssues([]);
    setTotal(0);
    setPage(0);
    loadIssues(1, false);
  }, [configured, connectMode, settingsLoaded, category, conditions, loadIssues]);

  const importedIds = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach((task) => {
      if (task.yunxiaoWorkitemId) set.add(task.yunxiaoWorkitemId);
    });
    return set;
  }, [tasks]);

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
      // 项目列表可能超过单页上限：按 total 翻页聚合，短页作为 x-total 缺失时的兜底终止条件。
      const perPage = 200;
      const maxPages = 50;
      let page = 1;
      let all: YunxiaoProject[] = [];
      let total = Infinity;
      while (page <= maxPages && all.length < total) {
        const result = await invoke<YunxiaoPage<YunxiaoProject>>("yunxiao_search_projects", {
          token,
          organizationId: orgId,
          page,
          perPage,
        });
        all = [...all, ...result.items];
        total = result.total;
        if (result.items.length < perPage) break;
        page += 1;
      }
      setCloudProjects(all);
      if (!selectedProjectId && all.length > 0) {
        setSelectedProjectId(all[0].id);
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
        currentUserId: filters.currentUserIdInput.trim() || undefined,
        currentUserName: filters.currentUserNameInput.trim() || undefined,
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

  const targetOptions = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <div style={s.yunxiaoPane}>
      <YunxiaoHeader
        onBack={onBack}
        meta={
          configured
            ? `${settings.organizationName ?? settings.organizationId} · ${settings.projectName ?? settings.projectId}`
            : t("yunxiao.notConnected")
        }
        configured={configured}
        refreshLoading={loading}
        onRefresh={() => loadIssues(1, false)}
        onReconnect={() => setConnectMode(true)}
      />

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
          currentUserIdInput={filters.currentUserIdInput}
          onCurrentUserIdChange={filters.setCurrentUserIdInput}
          currentUserNameInput={filters.currentUserNameInput}
          onCurrentUserNameChange={filters.setCurrentUserNameInput}
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
            <YunxiaoFilterBar
              assignedToMe={filters.assignedToMe}
              onToggleAssignedToMe={() => filters.setAssignedToMe((v) => !v)}
              assignedToMeDisabled={filters.currentUserError}
              assignedToMeDisabledTitle={
                filters.currentUserError ? t("yunxiao.currentUserUnresolved") : undefined
              }
              statusOptions={filters.statusOptions}
              selectedStatusIds={filters.selectedStatusIds}
              onStatusChange={filters.setSelectedStatusIds}
              statusesLoading={filters.statusesLoading}
              statusError={filters.statusError}
              onRetryStatuses={filters.retryStatuses}
            />
            <div style={s.yunxiaoSearchBox}>
              <Search size={13} strokeWidth={2} color="var(--text-muted)" />
              <input
                style={s.yunxiaoSearchInput}
                value={filters.query}
                onChange={(e) => filters.setQuery(e.target.value)}
                placeholder={t("yunxiao.searchPlaceholder")}
              />
            </div>
            <div style={s.yunxiaoCount}>{t("yunxiao.count", { count: total })}</div>
          </div>
          <YunxiaoImportBar
            targetProjectId={targetProjectId}
            onTargetProjectChange={setTargetProjectId}
            options={targetOptions}
          />
          <YunxiaoIssueList
            issues={issues}
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
