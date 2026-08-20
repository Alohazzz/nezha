import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { YunxiaoPage, YunxiaoProject } from "../../types";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";

/**
 * 组织下全部项目（按 total 翻页聚合，短页作为 x-total 缺失时的兜底终止条件）。
 * 同时供连接配置表单与议题区项目下拉使用。
 */
export function useYunxiaoCloudProjects() {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [cloudProjects, setCloudProjects] = useState<YunxiaoProject[]>([]);
  const [projectLoading, setProjectLoading] = useState(false);

  const loadProjects = useCallback(
    async (token: string, orgId: string): Promise<YunxiaoProject[]> => {
      setProjectLoading(true);
      try {
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
        return all;
      } catch (e) {
        showToast(t("yunxiao.loadProjectsFailed", { error: String(e) }), "error");
        return [];
      } finally {
        setProjectLoading(false);
      }
    },
    [showToast, t],
  );

  return { cloudProjects, projectLoading, loadProjects };
}
