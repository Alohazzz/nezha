import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { YunxiaoStatus, YunxiaoUserRef } from "../../types";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import { buildYunxiaoConditions } from "../../utils/yunxiao";

const YUNXIAO_FILTERS_PREFIX = "nezha:yunxiaoFilters:";
const SEARCH_DEBOUNCE_MS = 250;

/**
 * 云效议题页的过滤状态：搜索防抖、我负责的、状态多选、状态选项缓存、
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
  const [selectedStatusIds, setSelectedStatusIds] = useState<string[]>([]);
  const [statusOptions, setStatusOptions] = useState<YunxiaoStatus[]>([]);
  const [statusesLoading, setStatusesLoading] = useState(false);
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

  // 手动兜底输入框与设置缓存同步（仅设置变化时覆盖，输入中不受影响）。
  useEffect(() => {
    setCurrentUserIdInput(settings.currentUserId ?? "");
    setCurrentUserNameInput(settings.currentUserName ?? "");
  }, [settings.currentUserId, settings.currentUserName]);

  // 过滤偏好：按项目从 localStorage 恢复。
  useEffect(() => {
    if (!enabled || !projectId) return;
    const raw = localStorage.getItem(`${YUNXIAO_FILTERS_PREFIX}${projectId}`);
    try {
      const saved = raw
        ? (JSON.parse(raw) as { assignedToMe?: unknown; statusIds?: unknown })
        : null;
      setAssignedToMe(saved?.assignedToMe === true);
      setSelectedStatusIds(
        Array.isArray(saved?.statusIds)
          ? saved.statusIds.filter((x): x is string => typeof x === "string")
          : [],
      );
    } catch {
      setAssignedToMe(false);
      setSelectedStatusIds([]);
    }
    setLoadedFiltersProjectId(projectId);
  }, [enabled, projectId]);

  // 过滤偏好：按项目持久化（仅在该项目的值已恢复后写入，避免切换项目时覆盖）。
  useEffect(() => {
    if (!enabled || !projectId) return;
    if (loadedFiltersProjectId !== projectId) return;
    localStorage.setItem(
      `${YUNXIAO_FILTERS_PREFIX}${projectId}`,
      JSON.stringify({ assignedToMe, statusIds: selectedStatusIds }),
    );
  }, [enabled, projectId, loadedFiltersProjectId, assignedToMe, selectedStatusIds]);

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
      return;
    }
    let cancelled = false;
    setStatusesLoading(true);
    (async () => {
      try {
        const list = await invoke<YunxiaoStatus[]>("yunxiao_list_workitem_statuses", {
          token: settings.token,
          organizationId: settings.organizationId,
          projectId,
          categories,
        });
        if (cancelled) return;
        statusCacheRef.current.set(statusCacheKey, list);
        setStatusOptions(list);
      } catch (e) {
        console.error("[yunxiao] load workitem statuses failed:", e);
        if (!cancelled) setStatusOptions([]);
      } finally {
        if (!cancelled) setStatusesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, settings.token, settings.organizationId, projectId, categories, statusCacheKey]);

  const conditions = useMemo(
    () =>
      buildYunxiaoConditions({
        query: debouncedQuery,
        assignedToMe,
        currentUserId: currentUser?.id,
        selectedStatusIds,
      }),
    [debouncedQuery, assignedToMe, currentUser?.id, selectedStatusIds],
  );

  return {
    query,
    setQuery,
    assignedToMe,
    setAssignedToMe,
    selectedStatusIds,
    setSelectedStatusIds,
    statusOptions,
    statusesLoading,
    currentUser,
    currentUserError,
    currentUserIdInput,
    setCurrentUserIdInput,
    currentUserNameInput,
    setCurrentUserNameInput,
    conditions,
  };
}
