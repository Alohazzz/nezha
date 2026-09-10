import { useMemo } from "react";
import type { YunxiaoStatus, YunxiaoVersion } from "../../types";
import { useI18n } from "../../i18n";
import { FilterMultiSelect, type FilterOption } from "./FilterMultiSelect";
import s from "../../styles";

export function YunxiaoFilterBar({
  assignedToMe,
  onToggleAssignedToMe,
  assignedToMeDisabled,
  assignedToMeDisabledTitle,
  statusOptions,
  selectedStatusIds,
  onStatusChange,
  statusesLoading,
  statusError,
  onRetryStatuses,
  versionOptions,
  selectedVersionIds,
  onVersionChange,
  versionsLoading,
  versionError,
  onRetryVersions,
}: {
  assignedToMe: boolean;
  onToggleAssignedToMe: () => void;
  assignedToMeDisabled: boolean;
  assignedToMeDisabledTitle?: string;
  statusOptions: YunxiaoStatus[];
  selectedStatusIds: string[];
  onStatusChange: (ids: string[]) => void;
  statusesLoading: boolean;
  statusError?: string | null;
  onRetryStatuses?: () => void;
  versionOptions: YunxiaoVersion[];
  selectedVersionIds: string[];
  onVersionChange: (ids: string[]) => void;
  versionsLoading: boolean;
  versionError?: string | null;
  onRetryVersions?: () => void;
}) {
  const { t } = useI18n();

  const statusItems: FilterOption[] = useMemo(
    () =>
      statusOptions.map((status) => ({
        id: status.id,
        label: status.displayName ?? status.name,
      })),
    [statusOptions],
  );

  const versionItems: FilterOption[] = useMemo(
    () => versionOptions.map((version) => ({ id: version.id, label: version.name })),
    [versionOptions],
  );

  return (
    <>
      <button
        type="button"
        style={
          assignedToMeDisabled
            ? s.yunxiaoFilterBtnDisabled
            : assignedToMe
              ? s.yunxiaoFilterBtnActive
              : s.yunxiaoFilterBtn
        }
        disabled={assignedToMeDisabled}
        title={assignedToMeDisabledTitle}
        aria-pressed={assignedToMe}
        onClick={onToggleAssignedToMe}
      >
        {t("yunxiao.myIssues")}
      </button>
      <FilterMultiSelect
        options={statusItems}
        selectedIds={selectedStatusIds}
        onChange={onStatusChange}
        loading={statusesLoading}
        label={t("yunxiao.statusFilter")}
        selectedLabel={t("yunxiao.statusCount", { count: selectedStatusIds.length })}
        emptyLabel={t("yunxiao.noStatusOptions")}
        error={statusError}
        onRetry={onRetryStatuses}
      />
      <FilterMultiSelect
        options={versionItems}
        selectedIds={selectedVersionIds}
        onChange={onVersionChange}
        loading={versionsLoading}
        label={t("yunxiao.versionFilter")}
        selectedLabel={t("yunxiao.versionCount", { count: selectedVersionIds.length })}
        emptyLabel={t("yunxiao.noVersionOptions")}
        error={versionError}
        onRetry={onRetryVersions}
      />
    </>
  );
}
