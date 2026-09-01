import { useState } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { ChevronDown, Check } from "lucide-react";
import s from "../../styles";

export function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);

  return (
    <RadixSelect.Root value={value} onValueChange={onChange} open={open} onOpenChange={setOpen}>
      <RadixSelect.Trigger aria-label={current?.label ?? value} style={s.settingsSelectTrigger}>
        <RadixSelect.Value>{current?.label ?? value}</RadixSelect.Value>
        <RadixSelect.Icon asChild>
          <ChevronDown size={13} style={open ? s.settingsSelectIconOpen : s.settingsSelectIcon} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
          <RadixSelect.Viewport style={s.settingsSelectViewport}>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <RadixSelect.Item
                  key={option.value}
                  value={option.value}
                  className="radix-select-item"
                  style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                >
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator style={s.settingsSelectIndicator}>
                    <Check size={13} style={s.settingsSelectCheck} />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              );
            })}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}
