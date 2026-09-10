import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { YunxiaoStatus, YunxiaoUserRef, YunxiaoVersion } from "../../types";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import { buildYunxiaoConditions } from "../../utils/yunxiao";

const YUNXIAO_FILTERS_PREFIX = "nezha:yunxiaoFilters:";
const SEARCH_DEBOUNCE_MS = 250;
const FILTER_DEBOUNCE_MS = 300;

/**
 * 云效议题页的过滤状态：搜索防抖、我负责的、状态多选、版本多选、状态/版本选项缓存、
 * 当前用户识别（自动 + 手动兜底）与按项目的 localStorage 持久化。
 * conditions 为拼好的服务端查询 JSON 字符串（无过滤时为 undefined）。
 */
export function useYunxiaoFilters(
  settings: YunxiaoSettings,
  enabled: boolean,
  categories: string[],
  onSettingsUpdate: (s: YunxiaoSettings) => void,
) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [debouncedAssignedToMe, setDebouncedAssignedToMe] = useState(false);
  const [selectedStatusIds, setSelectedStatusIds] = useState<string[]>([]);
  const [debouncedStatusIds, setDebouncedStatusIds] = useState<string[]>([]);
  const [statusOptions, setStatusOptions] = useState<YunxiaoStatus[]>([]);
  const [statusesLoading, setStatusesLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusReloadKey, setStatusReloadKey] = useState(0);
  const [selectedVersionIds, setSelectedVersionIds] = useState<string[]>([]);
  const [debouncedVersionIds, setDebouncedVersionIds] = useState<string[]>([]);
  const [versionOptions, setVersionOptions] = useState<YunxiaoVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionReloadKey, setVersionReloadKey] = useState(0);
  const [currentUser, setCurrentUser] = useState<YunxiaoUserRef | null>(null);
  const [currentUserError, setCurrentUserError] = useState(false);
  const [currentUserIdInput, setCurrentUserIdInput] = useState("");
  const [currentUserNameInput, setCurrentUserNameInput] = useState("");
  const [loadedFiltersProjectId, setLoadedFiltersProjectId] = useState<string | null>(null);

  const projectId = settings.projectId;

  // 标题搜索防抖后进服务端 conditions（250ms）。
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query]);

  // 过滤条件（我负责的 / 状态多选 / 版本多选）防抖 300ms：合并快速连点产生的重复服务端重查。
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedAssignedToMe(assignedToMe);
      setDebouncedStatusIds(selectedStatusIds);
      setDebouncedVersionIds(selectedVersionIds);
    }, FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [assignedToMe, selectedStatusIds, selectedVersionIds]);

  // 手动兜底输入框与设置缓存同步（仅设置变化时覆盖，输入中不受影响）。
  useEffect(() => {
    setCurrentUserIdInput(settings.currentUserId ?? "");
    setCurrentUserNameInput(settings.currentUserName ?? "");
  }, [settings.currentUserId, settings.currentUserName]);

  // 过滤偏好：按项目从 localStorage 恢复。恢复值同步写入 debounced 态
  // （挂载恢复不是用户连续点击，无需防抖）——否则首查会以无条件发出，
  // 出现「过滤已选中但列表显示全部」的竞态（issue：云效列表过滤失效）。
  useEffect(() => {
    if (!enabled || !projectId) return;
    const raw = localStorage.getItem(`${YUNXIAO_FILTERS_PREFIX}${projectId}`);
    try {
      const saved = raw
        ? (JSON.parse(raw) as {
            assignedToMe?: unknown;
            statusIds?: unknown;
            versionIds?: unknown;
          })
        : null;
      const assigned = saved?.assignedToMe === true;
      const statusIds = Array.isArray(saved?.statusIds)
        ? saved.statusIds.filter((x): x is string => typeof x === "string")
        : [];
      const versionIds = Array.isArray(saved?.versionIds)
        ? saved.versionIds.filter((x): x is string => typeof x === "string")
        : [];
      setAssignedToMe(assigned);
      setSelectedStatusIds(statusIds);
      setSelectedVersionIds(versionIds);
      setDebouncedAssignedToMe(assigned);
      setDebouncedStatusIds(statusIds);
      setDebouncedVersionIds(versionIds);
    } catch {
      setAssignedToMe(false);
      setSelectedStatusIds([]);
      setSelectedVersionIds([]);
      setDebouncedAssignedToMe(false);
      setDebouncedStatusIds([]);
      setDebouncedVersionIds([]);
    }
    setLoadedFiltersProjectId(projectId);
  }, [enabled, projectId]);

  // 过滤偏好：按项目持久化（仅在该项目的值已恢复后写入，避免切换项目时覆盖）。
  useEffect(() => {
    if (!enabled || !projectId) return;
    if (loadedFiltersProjectId !== projectId) return;
    localStorage.setItem(
      `${YUNXIAO_FILTERS_PREFIX}${projectId}`,
      JSON.stringify({
        assignedToMe,
        statusIds: selectedStatusIds,
        versionIds: selectedVersionIds,
      }),
    );
  }, [
    enabled,
    projectId,
    loadedFiltersProjectId,
    assignedToMe,
    selectedStatusIds,
    selectedVersionIds,
  ]);

  // 当前用户：优先用设置缓存，否则调 /platform/user 自动识别并持久化。
  useEffect(() => {
    if (!enabled) return;
    if (settings.currentUserId) {
      setCurrentUser({
        id: settings.currentUserId,
        name: settings.currentUserName ?? settings.currentUserId,
      });
      setCurrentUserError(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const user = await invoke<YunxiaoUserRef>("yunxiao_get_current_user", {
          token: settings.token,
        });
        if (cancelled) return;
        setCurrentUser(user);
        setCurrentUserError(false);
        try {
          const appSettings = await invoke<AppSettings>("save_yunxiao_settings", {
            token: settings.token,
            organizationId: settings.organizationId,
            organizationName: settings.organizationName,
            projectId: settings.projectId,
            projectName: settings.projectName,
            currentUserId: user.id,
            currentUserName: user.name,
          });
          if (!cancelled) {
            onSettingsUpdate(appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS);
          }
        } catch (e) {
          console.error("[yunxiao] persist current user failed:", e);
        }
      } catch (e) {
        console.error("[yunxiao] fetch current user failed:", e);
        if (!cancelled) {
          setCurrentUser(null);
          setCurrentUserError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    settings.token,
    settings.currentUserId,
    settings.currentUserName,
    settings.organizationId,
    settings.organizationName,
    settings.projectId,
    settings.projectName,
    onSettingsUpdate,
  ]);

  // 状态选项：按 项目+分类 缓存；全部 = Req/Task/Bug 三类并集。
  const statusCacheRef = useRef<Map<string, YunxiaoStatus[]>>(new Map());
  const statusCacheKey = `${projectId}:${categories.join(",")}`;
  useEffect(() => {
    if (!enabled || !projectId) return;
    const cached = statusCacheRef.current.get(statusCacheKey);
    if (cached) {
      setStatusOptions(cached);
      setStatusesLoading(false);
      setStatusError(null);
      return;
    }
    let cancelled = false;
    setStatusesLoading(true);
    setStatusError(null);
    (async () => {
      try {
        const list = await invoke<YunxiaoStatus[]>("yunxiao_list_workitem_statuses", {
          token: settings.token,
          organizationId: settings.organizationId,
          projectId,
          categories,
        });
        if (cancelled) return;
        setStatusError(null);
        statusCacheRef.current.set(statusCacheKey, list);
        setStatusOptions(list);
      } catch (e) {
        console.error("[yunxiao] load workitem statuses failed:", e);
        if (!cancelled) {
          setStatusOptions([]);
          setStatusError(String(e));
        }
      } finally {
        if (!cancelled) setStatusesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    settings.token,
    settings.organizationId,
    projectId,
    categories,
    statusCacheKey,
    statusReloadKey,
  ]);

  /** 状态列表加载失败后手动重试（重新触发 effect，绕过失败的空缓存）。 */
  const retryStatuses = useCallback(() => {
    setStatusError(null);
    setStatusesLoading(true);
    setStatusReloadKey((k) => k + 1);
  }, []);

  // 版本选项：按项目缓存（版本无分类维度，与分类 Tab 无关）。
  const versionCacheRef = useRef<Map<string, YunxiaoVersion[]>>(new Map());
  useEffect(() => {
    if (!enabled || !projectId) return;
    const cached = versionCacheRef.current.get(projectId);
    if (cached) {
      setVersionOptions(cached);
      setVersionsLoading(false);
      setVersionError(null);
      return;
    }
    let cancelled = false;
    setVersionsLoading(true);
    setVersionError(null);
    (async () => {
      try {
        const response = await invoke<YunxiaoVersion[]>("yunxiao_list_versions", {
          token: settings.token,
          organizationId: settings.organizationId,
          projectId,
        });
        if (cancelled) return;
        const list = Array.isArray(response) ? response : [];
        setVersionError(null);
        versionCacheRef.current.set(projectId, list);
        setVersionOptions(list);
      } catch (e) {
        console.error("[yunxiao] load versions failed:", e);
        if (!cancelled) {
          setVersionOptions([]);
          setVersionError(String(e));
        }
      } finally {
        if (!cancelled) setVersionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    settings.token,
    settings.organizationId,
    projectId,
    versionReloadKey,
  ]);

  /** 版本列表加载失败后手动重试（重新触发 effect，绕过失败的空缓存）。 */
  const retryVersions = useCallback(() => {
    setVersionError(null);
    setVersionsLoading(true);
    setVersionReloadKey((k) => k + 1);
  }, []);

  const conditions = useMemo(
    () =>
      buildYunxiaoConditions({
        query: debouncedQuery,
        assignedToMe: debouncedAssignedToMe,
        currentUserId: currentUser?.id,
        selectedStatusIds: debouncedStatusIds,
        selectedVersionIds: debouncedVersionIds,
      }),
    [
      debouncedQuery,
      debouncedAssignedToMe,
      currentUser?.id,
      debouncedStatusIds,
      debouncedVersionIds,
    ],
  );

  /** 本项目的过滤偏好已恢复（首查应等待此标志，避免无条件请求先发出）。 */
  const filtersReady = enabled && loadedFiltersProjectId === projectId;

  return {
    query,
    setQuery,
    assignedToMe,
    setAssignedToMe,
    selectedStatusIds,
    setSelectedStatusIds,
    statusOptions,
    statusesLoading,
    statusError,
    retryStatuses,
    selectedVersionIds,
    setSelectedVersionIds,
    versionOptions,
    versionsLoading,
    versionError,
    retryVersions,
    currentUser,
    currentUserError,
    currentUserIdInput,
    setCurrentUserIdInput,
    currentUserNameInput,
    setCurrentUserNameInput,
    conditions,
    filtersReady,
  };
}
