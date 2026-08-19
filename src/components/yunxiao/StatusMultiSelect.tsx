import { useState } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { YunxiaoStatus } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";

export function StatusMultiSelect({
  options,
  selectedIds,
  onChange,
  loading = false,
  label,
  emptyHint,
  error = null,
  onRetry,
}: {
  options: YunxiaoStatus[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  loading?: boolean;
  label: string;
  emptyHint?: string;
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
        <button
          type="button"
          style={triggerStyle}
          aria-label={label}
        >
          {selectedCount > 0
            ? t("yunxiao.statusCount", { count: selectedCount })
            : label}
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
                  {t("yunxiao.noStatusOptions")}
                  {emptyHint ? `（${emptyHint}）` : ""}
                </div>
                {error && onRetry && (
                  <button type="button" style={s.yunxiaoFilterRetry} onClick={onRetry}>
                    {t("yunxiao.retry")}
                  </button>
                )}
              </div>
            ) : (
              options.map((status) => {
                const checked = selectedIds.includes(status.id);
                return (
                  <label
                    key={status.id}
                    style={checked ? s.yunxiaoFilterOptionChecked : s.yunxiaoFilterOption}
                  >
                    <input
                      type="checkbox"
                      style={s.yunxiaoFilterCheckbox}
                      checked={checked}
                      onChange={() => toggle(status.id)}
                    />
                    <span style={s.yunxiaoFilterOptionLabel}>
                      {status.displayName ?? status.name}
                    </span>
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
