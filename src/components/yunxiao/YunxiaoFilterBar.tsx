import type { YunxiaoStatus } from "../../types";
import { useI18n } from "../../i18n";
import { StatusMultiSelect } from "./StatusMultiSelect";
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
}: {
  assignedToMe: boolean;
  onToggleAssignedToMe: () => void;
  assignedToMeDisabled: boolean;
  assignedToMeDisabledTitle?: string;
  statusOptions: YunxiaoStatus[];
  selectedStatusIds: string[];
  onStatusChange: (ids: string[]) => void;
  statusesLoading: boolean;
}) {
  const { t } = useI18n();

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
      <StatusMultiSelect
        options={statusOptions}
        selectedIds={selectedStatusIds}
        onChange={onStatusChange}
        loading={statusesLoading}
        label={t("yunxiao.statusFilter")}
      />
    </>
  );
}
