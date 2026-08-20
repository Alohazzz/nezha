import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { YunxiaoProject } from "../../types";
import { useI18n } from "../../i18n";
import { useToast } from "../Toast";
import {
  EMPTY_YUNXIAO_SETTINGS,
  type AppSettings,
  type YunxiaoSettings,
} from "../app-settings/types";
import { SelectField } from "./SelectField";
import s from "../../styles";

/**
 * 议题区项目选择下拉：无需进设置即可切换云效项目。
 * 切换通过 save_yunxiao_settings 持久化，成功后由父组件更新 settings 触发议题重载。
 */
export function YunxiaoProjectSelect({
  settings,
  cloudProjects,
  projectLoading,
  onSettingsChange,
}: {
  settings: YunxiaoSettings;
  cloudProjects: YunxiaoProject[];
  projectLoading: boolean;
  onSettingsChange: (settings: YunxiaoSettings) => void;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const [switchingProject, setSwitchingProject] = useState(false);

  // 下拉选项：始终包含当前已配置项目，避免项目列表加载失败时下拉为空。
  const options = useMemo(() => {
    const list = cloudProjects.map((p) => ({ value: p.id, label: p.name }));
    if (settings.projectId && !list.some((o) => o.value === settings.projectId)) {
      list.unshift({
        value: settings.projectId,
        label: settings.projectName ?? settings.projectId,
      });
    }
    return list;
  }, [cloudProjects, settings.projectId, settings.projectName]);

  async function handleSwitch(projectId: string) {
    if (!projectId || projectId === settings.projectId) return;
    const proj = cloudProjects.find((p) => p.id === projectId);
    if (!proj) return;
    setSwitchingProject(true);
    try {
      const appSettings = await invoke<AppSettings>("save_yunxiao_settings", {
        token: settings.token,
        organizationId: settings.organizationId,
        organizationName: settings.organizationName,
        projectId: proj.id,
        projectName: proj.name,
        currentUserId: settings.currentUserId,
        currentUserName: settings.currentUserName,
      });
      onSettingsChange(appSettings.yunxiao ?? EMPTY_YUNXIAO_SETTINGS);
      showToast(t("yunxiao.projectSwitched", { name: proj.name }));
    } catch (e) {
      showToast(t("yunxiao.projectSwitchFailed", { error: String(e) }), "error");
    } finally {
      setSwitchingProject(false);
    }
  }

  return (
    <div style={s.yunxiaoProjectPicker}>
      <span style={s.yunxiaoFieldLabel}>{t("yunxiao.project")}</span>
      <SelectField
        value={settings.projectId}
        onChange={handleSwitch}
        options={options}
        placeholder={t("yunxiao.selectProject")}
        disabled={switchingProject || projectLoading}
        triggerStyle={s.yunxiaoProjectSelect}
      />
    </div>
  );
}
