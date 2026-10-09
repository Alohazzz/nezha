import { useState } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 计划完成时间快捷项：all = 不过滤；week/month = 预设；custom = 自定义起止。 */
export interface PlanEndPresetOption {
  value: "all" | "week" | "month" | "custom";
  label: string;
}

/**
 * 计划完成时间单选过滤（Radix Popover + 单选列表）。
 * 选「自定义」时在弹层内联展开起止日期输入（yyyy-mm-dd），任一为空 = 该侧不限制。
 */
export function FilterPlanEndSelect({
  options,
  value,
  onChange,
  customFrom,
  customTo,
  onCustomChange,
}: {
  options: PlanEndPresetOption[];
  value: PlanEndPresetOption["value"];
  onChange: (value: PlanEndPresetOption["value"]) => void;
  customFrom: string;
  customTo: string;
  onCustomChange: (from: string, to: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerStyle = value !== "all" ? s.yunxiaoFilterBtnActive : s.yunxiaoFilterBtn;
  const selectedLabel =
    options.find((o) => o.value === value)?.label ?? t("yunxiao.planEnd.all");

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button type="button" style={triggerStyle} aria-label={t("yunxiao.planEnd.filter")}>
          <Calendar size={12} strokeWidth={2} />
          {value !== "all" ? selectedLabel : t("yunxiao.planEnd.filter")}
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content sideOffset={4} align="start" style={s.yunxiaoFilterPopover}>
          <div style={s.yunxiaoFilterPopoverHeader}>
            <span>{t("yunxiao.planEnd.filter")}</span>
            {value !== "all" && (
              <button
                type="button"
                style={s.yunxiaoFilterClear}
                onClick={() => {
                  onChange("all");
                  onCustomChange("", "");
                }}
              >
                {t("yunxiao.clear")}
              </button>
            )}
          </div>
          <div style={s.yunxiaoFilterOptions}>
            {options.map((option) => {
              const checked = option.value === value;
              return (
                <label
                  key={option.value}
                  style={checked ? s.yunxiaoFilterOptionChecked : s.yunxiaoFilterOption}
                >
                  <input
                    type="radio"
                    name="yunxiao-plan-end-preset"
                    style={s.yunxiaoFilterCheckbox}
                    checked={checked}
                    onChange={() => onChange(option.value)}
                  />
                  <span style={s.yunxiaoFilterOptionLabel}>{option.label}</span>
                  {checked && <Check size={12} strokeWidth={2.5} />}
                </label>
              );
            })}
            {value === "custom" && (
              <div style={s.yunxiaoPlanEndCustomRow}>
                <input
                  type="date"
                  style={s.yunxiaoPlanEndDateInput}
                  value={customFrom}
                  onChange={(e) => onCustomChange(e.target.value, customTo)}
                  title={t("yunxiao.planEnd.from")}
                />
                <span style={s.yunxiaoPlanEndRangeDash}>–</span>
                <input
                  type="date"
                  style={s.yunxiaoPlanEndDateInput}
                  value={customTo}
                  onChange={(e) => onCustomChange(customFrom, e.target.value)}
                  title={t("yunxiao.planEnd.to")}
                />
              </div>
            )}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
