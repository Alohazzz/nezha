import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search, Sparkles, X } from "lucide-react";
import type {
  AgentType,
  PermissionMode,
  Plan,
  PlanIssue,
  Project,
  Task,
  YunxiaoOrganization,
  YunxiaoPage,
  YunxiaoWorkitem,
} from "../../types";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import {
  collectOccupiedYunxiaoWorkitemIds,
  isYunxiaoWorkitemImported,
} from "../../utils/yunxiao";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import { YunxiaoHeader } from "./YunxiaoHeader";
import { YunxiaoFilterBar } from "./YunxiaoFilterBar";
import { YunxiaoImportBar } from "./YunxiaoImportBar";
import { useYunxiaoFilters } from "./useYunxiaoFilters";
import { YunxiaoConnectForm } from "./YunxiaoConnectForm";
import { YunxiaoIssueList } from "./YunxiaoIssueList";
import { YunxiaoProjectSelect } from "./YunxiaoProjectSelect";
import { useYunxiaoCloudProjects } from "./useYunxiaoCloudProjects";
import { PlanLaunchDialog } from "./plan/PlanLaunchDialog";
import { DirectLaunchDialog, type DirectLaunchOptions } from "./DirectLaunchDialog";
import s from "../../styles";

const PAGE_SIZE = 100;
const YUNXIAO_LAST_PROJECT_KEY = "nezha:yunxiaoLastProjectId";
/** 多选软上限：讨论会话上下文与图片量的现实约束，超出仅提醒不阻断已选项。 */
const PLAN_SELECT_SOFT_LIMIT = 10;

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
  plans,
  onBack,
  onCreatePlan,
  onStartPlanDiscussion,
  onStartDirectExecution,
  onCancelPlan,
}: {
  projects: Project[];
  tasks: Task[];
  /** 去重第二来源：非取消方案的议题也算占用（讨论中/待生成待办/执行中/已完成）。 */
  plans: Plan[];
  onBack: () => void;
  onCreatePlan: (targetProjectId: string, issues: PlanIssue[]) => Plan;
  onStartPlanDiscussion: (
    planId: string,
    prompt: string,
    agent: AgentType,
    permissionMode: PermissionMode,
  ) => void;
  /** 行内「直接开始」：跳过讨论链路，直接创建绑定议题的执行任务并启动。 */
  onStartDirectExecution: (
    issue: YunxiaoWorkitem,
    targetProjectId: string,
    options: DirectLaunchOptions,
  ) => void | Promise<void>;
  onCancelPlan: (planId: string) => void | Promise<void>;
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
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [saving, setSaving] = useState(false);
  const { cloudProjects, projectLoading, loadProjects } = useYunxiaoCloudProjects();

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
  const { conditions, filtersReady } = filters;

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
    // 过滤偏好恢复完成前不发首查：无条件请求会先返回全量列表，
    // 恢复后的条件重查再覆盖——表现为「选了过滤却显示全部」的闪烁/竞态。
    if (!filtersReady) return;
    setIssues([]);
    setTotal(0);
    setPage(0);
    loadIssues(1, false);
  }, [configured, connectMode, settingsLoaded, filtersReady, category, conditions, loadIssues]);

  // 议题占用集合：任务直接绑定 + 仍被存活任务引用的方案（孤儿方案不占用，
  // 见 collectOccupiedYunxiaoWorkitemIds 注释）。
  const importedIds = useMemo(
    () => collectOccupiedYunxiaoWorkitemIds(tasks, plans),
    [tasks, plans],
  );

  // ── 多议题联合分析：勾选 + 底部操作栏 + 发起对话框 ─────────────────────────
  const [selectedIssueIds, setSelectedIssueIds] = useState<ReadonlySet<string>>(new Set());
  const [launchIssues, setLaunchIssues] = useState<YunxiaoWorkitem[] | null>(null);
  // 「直接开始」弹窗的待确认议题（null = 未打开）。
  const [directIssue, setDirectIssue] = useState<YunxiaoWorkitem | null>(null);

  const selectionMode = selectedIssueIds.size > 0;

  const handleToggleSelect = useCallback(
    (issue: YunxiaoWorkitem) => {
      if (isYunxiaoWorkitemImported(tasks, plans, issue.id)) {
        showToast(t("yunxiao.importDuplicate"), "warning");
        return;
      }
      setSelectedIssueIds((prev) => {
        const next = new Set(prev);
        if (next.has(issue.id)) {
          next.delete(issue.id);
          return next;
        }
        if (next.size >= PLAN_SELECT_SOFT_LIMIT) {
          showToast(
            t("plan.selectLimit", { limit: PLAN_SELECT_SOFT_LIMIT }),
            "warning",
          );
          return prev;
        }
        next.add(issue.id);
        return next;
      });
    },
    [tasks, plans, showToast, t],
  );

  const selectedIssues = useMemo(
    () => issues.filter((issue) => selectedIssueIds.has(issue.id)),
    [issues, selectedIssueIds],
  );

  const targetProject = projects.find((p) => p.id === targetProjectId) ?? null;

  const handleLaunchPlan = useCallback(() => {
    if (selectedIssues.length === 0) return;
    if (!targetProjectId) {
      showToast(t("yunxiao.targetProjectRequired"), "warning");
      return;
    }
    if (!targetProject) return;
    setLaunchIssues(selectedIssues);
    setSelectedIssueIds(new Set());
    localStorage.setItem(YUNXIAO_LAST_PROJECT_KEY, targetProjectId);
  }, [selectedIssues, targetProjectId, targetProject, showToast, t]);

  /** 行内「发起讨论」：单条快捷入口，与多选发起同一对话框同一链路（N=1）。 */
  const handleDiscussIssue = useCallback(
    (issue: YunxiaoWorkitem) => {
      if (!targetProjectId) {
        showToast(t("yunxiao.targetProjectRequired"), "warning");
        return;
      }
      if (!targetProject) return;
      setLaunchIssues([issue]);
      localStorage.setItem(YUNXIAO_LAST_PROJECT_KEY, targetProjectId);
    },
    [targetProjectId, targetProject, showToast, t],
  );

  /** 行内「直接开始」：先弹确认对话框（拉详情预览 + 补充 + 工作流选择），确认后启动。 */
  const handleDirectStartIssue = useCallback(
    (issue: YunxiaoWorkitem) => {
      if (!targetProjectId) {
        showToast(t("yunxiao.targetProjectRequired"), "warning");
        return;
      }
      if (!targetProject) return;
      // 已导入守卫与讨论入口同源（App 层 handler 还有一道，双保险）。
      if (isYunxiaoWorkitemImported(tasks, plans, issue.id)) {
        showToast(t("yunxiao.importDuplicate"), "warning");
        return;
      }
      localStorage.setItem(YUNXIAO_LAST_PROJECT_KEY, targetProjectId);
      setDirectIssue(issue);
    },
    [targetProjectId, targetProject, tasks, plans, showToast, t],
  );

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
    const all = await loadProjects(token, orgId);
    if (!selectedProjectId && all.length > 0) {
      setSelectedProjectId(all[0].id);
    }
  }

  // 配置完成后自动拉取项目列表，供议题区下拉直接切换项目（无需进设置）。
  const loadedCloudOrgRef = useRef<string | null>(null);
  useEffect(() => {
    if (!configured || connectMode || !settingsLoaded) return;
    if (!settings.token || !settings.organizationId) return;
    if (loadedCloudOrgRef.current === settings.organizationId) return;
    loadedCloudOrgRef.current = settings.organizationId;
    void loadProjects(settings.token, settings.organizationId);
  }, [
    configured,
    connectMode,
    settingsLoaded,
    settings.token,
    settings.organizationId,
    loadProjects,
  ]);

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
            <YunxiaoProjectSelect
              settings={settings}
              cloudProjects={cloudProjects}
              projectLoading={projectLoading}
              onSettingsChange={(next) => {
                setSettings(next);
                setSelectedProjectId(next.projectId);
              }}
            />
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
              versionOptions={filters.versionOptions}
              selectedVersionIds={filters.selectedVersionIds}
              onVersionChange={filters.setSelectedVersionIds}
              versionsLoading={filters.versionsLoading}
              versionError={filters.versionError}
              onRetryVersions={filters.retryVersions}
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
            selectedIds={selectedIssueIds}
            selectionMode={selectionMode}
            onToggleSelect={handleToggleSelect}
            onDiscuss={handleDiscussIssue}
            onDirectStart={handleDirectStartIssue}
            yunxiaoProjectId={settings.projectId}
            onLoadMore={() => loadIssues(page + 1, true)}
          />
          {selectionMode && (
            <div style={s.yunxiaoSelectBar}>
              <span style={s.yunxiaoSelectCount}>
                {t("plan.selectedCount", { count: selectedIssueIds.size })}
              </span>
              <button
                type="button"
                style={s.yunxiaoSelectPrimaryBtn}
                onClick={handleLaunchPlan}
              >
                <Sparkles size={12} strokeWidth={2.2} />
                {t("plan.launchAction")}
              </button>
              <button
                type="button"
                style={s.yunxiaoSelectGhostBtn}
                onClick={() => setSelectedIssueIds(new Set())}
              >
                <X size={12} strokeWidth={2.2} />
                {t("yunxiao.clear")}
              </button>
            </div>
          )}
        </>
      )}
      {launchIssues && targetProject && (
        <PlanLaunchDialog
          key={launchIssues.map((issue) => issue.id).join(",")}
          issues={launchIssues}
          targetProjectId={targetProject.id}
          projectPath={targetProject.path}
          projectName={targetProject.name}
          settings={settings}
          onCreatePlan={onCreatePlan}
          onStartDiscussion={onStartPlanDiscussion}
          onCancelPlan={onCancelPlan}
          onClose={() => setLaunchIssues(null)}
        />
      )}
      {directIssue && targetProject && (
        <DirectLaunchDialog
          key={directIssue.id}
          issue={directIssue}
          targetProjectId={targetProject.id}
          projectName={targetProject.name}
          settings={settings}
          onStart={(options) => {
            // 确认后立即关闭弹窗，任务创建/下图/启动在 App 层后台进行
            // （失败会 toast 并把任务置 failed，重试 = 删任务重点）。
            void Promise.resolve(onStartDirectExecution(directIssue, targetProject.id, options)).catch(
              () => undefined,
            );
            setDirectIssue(null);
          }}
          onClose={() => setDirectIssue(null)}
        />
      )}
    </div>
  );
}
