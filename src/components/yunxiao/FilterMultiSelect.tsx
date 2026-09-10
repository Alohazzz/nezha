import { useState } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 通用多选过滤项：id 用于拼服务端 conditions，label 用于展示。 */
export interface FilterOption {
  id: string;
  label: string;
}

/**
 * 通用多选过滤控件（Radix Popover + 复选框列表）。
 * 状态过滤、版本过滤等复用同一形态：空选 = 不加该条件；
 * 触发器在有选中项时显示调用方给定的摘要文案（selectedLabel）。
 */
export function FilterMultiSelect({
  options,
  selectedIds,
  onChange,
  loading = false,
  label,
  selectedLabel,
  emptyLabel,
  error = null,
  onRetry,
}: {
  options: FilterOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  /** 无选中项时触发器文案，也是弹层标题。 */
  label: string;
  /** 有选中项时触发器文案（调用方用 i18n 拼好，如「状态：2 项」）。 */
  selectedLabel: string;
  /** 选项为空时的提示文案。 */
  emptyLabel: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selectedCount = selectedIds.length;
  const triggerStyle =
    selectedCount > 0 ? s.yunxiaoFilterBtnActive : s.yunxiaoFilterBtn;

  function toggle(id: string) {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  }

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button type="button" style={triggerStyle} aria-label={label}>
          {selectedCount > 0 ? selectedLabel : label}
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content sideOffset={4} align="start" style={s.yunxiaoFilterPopover}>
          <div style={s.yunxiaoFilterPopoverHeader}>
            <span>{label}</span>
            {selectedCount > 0 && (
              <button
                type="button"
                style={s.yunxiaoFilterClear}
                onClick={() => onChange([])}
              >
                {t("yunxiao.clear")}
              </button>
            )}
          </div>
          <div style={s.yunxiaoFilterOptions}>
            {loading && options.length === 0 ? (
              <div style={s.yunxiaoFilterLoading}>
                <Loader2 size={14} className="spin" />
              </div>
            ) : options.length === 0 ? (
              <div style={s.yunxiaoFilterEmpty}>
                <div>
                  {emptyLabel}
                  {error ? `（${error}）` : ""}
                </div>
                {error && onRetry && (
                  <button type="button" style={s.yunxiaoFilterRetry} onClick={onRetry}>
                    {t("yunxiao.retry")}
                  </button>
                )}
              </div>
            ) : (
              options.map((option) => {
                const checked = selectedIds.includes(option.id);
                return (
                  <label
                    key={option.id}
                    style={checked ? s.yunxiaoFilterOptionChecked : s.yunxiaoFilterOption}
                  >
                    <input
                      type="checkbox"
                      style={s.yunxiaoFilterCheckbox}
                      checked={checked}
                      onChange={() => toggle(option.id)}
                    />
                    <span style={s.yunxiaoFilterOptionLabel}>{option.label}</span>
                    {checked && <Check size={12} strokeWidth={2.5} />}
                  </label>
                );
              })
            )}
          </div>
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
