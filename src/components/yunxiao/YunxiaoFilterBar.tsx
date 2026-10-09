import { useMemo } from "react";
import type { YunxiaoStatus, YunxiaoVersion } from "../../types";
import { useI18n } from "../../i18n";
import { FilterMultiSelect, type FilterOption } from "./FilterMultiSelect";
import { FilterPlanEndSelect, type PlanEndPresetOption } from "./FilterPlanEndSelect";
import type { PlanEndPreset } from "./useYunxiaoFilters";
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
  productOptions,
  selectedProducts,
  onProductsChange,
  productsDegraded,
  planEndPreset,
  onPlanEndPresetChange,
  planEndCustomFrom,
  planEndCustomTo,
  onPlanEndCustomChange,
  planEndEnabled,
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
  /** 产品候选列表（云端产品优先，降级为已加载议题去重）。 */
  productOptions: string[];
  selectedProducts: string[];
  onProductsChange: (products: string[]) => void;
  /** 产品候选来自降级（已加载议题去重）时提示用户。 */
  productsDegraded: boolean;
  planEndPreset: PlanEndPreset;
  onPlanEndPresetChange: (preset: PlanEndPreset) => void;
  planEndCustomFrom: string;
  planEndCustomTo: string;
  onPlanEndCustomChange: (from: string, to: string) => void;
  /** 「计划完成时间」字段是否存在（探测不到时隐藏该过滤器）。 */
  planEndEnabled: boolean;
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

  const productItems: FilterOption[] = useMemo(
    () => productOptions.map((name) => ({ id: name, label: name })),
    [productOptions],
  );

  const planEndPresetOptions: PlanEndPresetOption[] = useMemo(
    () => [
      { value: "all", label: t("yunxiao.planEnd.all") },
      { value: "week", label: t("yunxiao.planEnd.week") },
      { value: "month", label: t("yunxiao.planEnd.month") },
      { value: "custom", label: t("yunxiao.planEnd.custom") },
    ],
    [t],
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
        options={productItems}
        selectedIds={selectedProducts}
        onChange={onProductsChange}
        label={t("yunxiao.productFilter")}
        selectedLabel={t("yunxiao.productCount", { count: selectedProducts.length })}
        emptyLabel={
          productsDegraded
            ? t("yunxiao.productDegraded")
            : t("yunxiao.noProductOptions")
        }
      />
      {planEndEnabled && (
        <FilterPlanEndSelect
          options={planEndPresetOptions}
          value={planEndPreset}
          onChange={onPlanEndPresetChange}
          customFrom={planEndCustomFrom}
          customTo={planEndCustomTo}
          onCustomChange={onPlanEndCustomChange}
        />
      )}
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
