import { useMemo, useState } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

export interface MultiSelectOption {
  value: string;
  label: string;
  /** 触发的原生 tooltip，通常放完整路径以便区分同名项。 */
  title?: string;
}

/**
 * 设置页的多选下拉（Radix Popover + 复选框）。
 *
 * 为什么不用 Radix Select：它只支持单选，多选要另配 Checkbox 并自己管开合，
 * 不如直接用 Popover 表达。触发器沿用 `settingsSelect*` 观感，与相邻单选框一致。
 *
 * `allOption`：当「空选择」在业务上是有效状态（例如空 = 不限制），传它把该状态
 * 显式渲染成一个「全部」哨兵项。否则空选择只能靠「什么都不勾」表达，与复选框
 * 「勾选=包含」的直觉冲突——用户全不勾时反而看到全部，是很容易踩的坑。
 * 勾选「全部」回调空数组；勾选任一具体项即自动取消「全部」。
 *
 * 有 `allOption` 时它同时充当空态文案，`placeholder` 可省略。
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  emptyLabel,
  allOption,
  loading = false,
  disabled = false,
}: {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  /** 无 `allOption` 时，无选中项的触发器文案（有 `allOption` 时被它取代）。 */
  placeholder?: string;
  /** 选项列表为空时的提示文案（`allOption` 存在时列表不会为空，故不显示）。 */
  emptyLabel: string;
  /** 「空 = 不限制」时的哨兵项文案；不传则无此项、空选择即「未选」。 */
  allOption?: string;
  loading?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const isAll = selected.length === 0;
  // 两种空态语义不同：有 allOption 时空 = 「全部」，否则空 = 「未选择」。
  const emptyText = allOption ?? placeholder ?? t("common.noData");

  // 已选项按 options 的顺序展示，避免勾选先后影响触发器文案；
  // 已保存但当前未发现的值（仓库改名 / 子模块未初始化）也照原样列出，不能悄悄吞掉。
  const summary = useMemo(() => {
    if (selected.length === 0) return "";
    const ordered = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
    const unknown = selected.filter((v) => !options.some((o) => o.value === v));
    return [...ordered, ...unknown].join(", ");
  }, [options, selected]);

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }

  const headerText = isAll
    ? emptyText
    : t("common.selectedCount", { n: selected.length });

  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          style={s.settingsMultiSelectTrigger}
          disabled={disabled}
          aria-label={emptyText}
        >
          <span
            style={summary ? s.settingsMultiSelectValue : s.settingsMultiSelectPlaceholder}
          >
            {summary || emptyText}
          </span>
          <ChevronDown
            size={13}
            style={open ? s.settingsSelectIconOpen : s.settingsSelectIcon}
          />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          sideOffset={4}
          align="start"
          // 设置弹窗内容很长，这个下拉常出现在靠近视口底部的位置。若不预留碰撞边距，
          // Radix 不会感知下方空间不足，弹层会向下展开、末项被视口裁掉且无法滚动到。
          collisionPadding={{ top: 8, bottom: 56, left: 8, right: 8 }}
          style={s.settingsMultiSelectContent}
        >
          <div style={s.settingsMultiSelectHeader}>
            <span>{headerText}</span>
            {/* 有「全部」哨兵项时，它本身就是取消选择的入口，不再重复放清除按钮 */}
            {!allOption && selected.length > 0 && (
              <button
                type="button"
                style={s.settingsMultiSelectClear}
                onClick={() => onChange([])}
              >
                {t("common.clear")}
              </button>
            )}
          </div>
          {loading ? (
            <div style={s.settingsMultiSelectHint}>
              <Loader2 size={13} className="spin" /> {t("common.loading")}
            </div>
          ) : (
            <>
              {allOption && (
                <>
                  <label style={isAll ? s.settingsMultiSelectOptionChecked : s.settingsMultiSelectOption}>
                    <input
                      type="checkbox"
                      style={s.settingsMultiSelectCheckbox}
                      checked={isAll}
                      onChange={() => onChange([])}
                    />
                    <span style={s.settingsMultiSelectLabel}>{allOption}</span>
                    {isAll && <Check size={13} strokeWidth={2.5} />}
                  </label>
                  <div style={s.settingsMultiSelectSeparator} />
                </>
              )}
              {options.length === 0 ? (
                <div style={s.settingsMultiSelectHint}>{emptyLabel}</div>
              ) : (
                <div style={s.settingsMultiSelectList}>
                  {options.map((option) => {
                    const checked = selected.includes(option.value);
                    return (
                      <label
                        key={option.value}
                        title={option.title}
                        style={
                          checked
                            ? s.settingsMultiSelectOptionChecked
                            : s.settingsMultiSelectOption
                        }
                      >
                        <input
                          type="checkbox"
                          style={s.settingsMultiSelectCheckbox}
                          checked={checked}
                          onChange={() => toggle(option.value)}
                        />
                        <span style={s.settingsMultiSelectLabel}>{option.label}</span>
                        {checked && <Check size={13} strokeWidth={2.5} />}
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
