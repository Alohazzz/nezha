import { useState } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import s from "../../styles";

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
  disabled = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <RadixSelect.Root
      value={value || undefined}
      onValueChange={onChange}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        aria-label={current?.label ?? placeholder}
        style={s.settingsSelectTrigger}
      >
        <RadixSelect.Value placeholder={placeholder}>
          {current ? current.label : undefined}
        </RadixSelect.Value>
        <RadixSelect.Icon asChild>
          <ChevronDown size={13} style={open ? s.settingsSelectIconOpen : s.settingsSelectIcon} />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={4} style={s.settingsSelectContent}>
          <RadixSelect.Viewport style={s.settingsSelectViewport}>
            {options.map((opt) => {
              const selected = opt.value === value;
              return (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  className="radix-select-item"
                  style={selected ? s.settingsSelectOptionSelected : s.settingsSelectOption}
                >
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
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