import { useState } from "react";
import { ChevronDown, GitBranch, Check } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";

export interface WorktreeScopeOption {
  key: string;
  label: string;
  /** 下拉里的路径详情；触发器仍展示 label，避免长路径撑宽右侧工具栏。 */
  description?: string;
}

export function WorktreeScopeSelect({
  options,
  value,
  onChange,
}: {
  options: WorktreeScopeOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.key === value) ?? options[0];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="radix-select-trigger">
          <GitBranch size={13} />
          <span className="radix-select-trigger-value">{current?.label ?? "选择"}</span>
          <ChevronDown size={13} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="branch-popover-content" sideOffset={4} align="start">
          <div className="branch-popover-list">
            {options.map((o) => (
              <button
                key={o.key || "__main__"}
                className="branch-popover-item"
                onClick={() => {
                  onChange(o.key);
                  setOpen(false);
                }}
              >
                <GitBranch size={12} />
                <span className="branch-popover-item-name">
                  <span className="branch-popover-item-title">
                    {o.label}
                    {o.key === value ? " · 当前" : ""}
                  </span>
                  {o.description && (
                    <span className="branch-popover-item-description">{o.description}</span>
                  )}
                </span>
                {o.key === value && <Check size={12} />}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
