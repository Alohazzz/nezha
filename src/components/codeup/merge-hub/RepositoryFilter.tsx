import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { CodeupRepository } from "../../../types";
export function RepositoryFilter({
  repos,
  value,
  onChange,
  disabled,
}: {
  repos: CodeupRepository[];
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const options = [{ id: "all", namespace: "全部仓库", name: "全部仓库" }, ...repos];
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger className="mh-button mh-repo-filter" aria-label="筛选仓库">
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="mh-select-content" position="popper" sideOffset={6}>
          <Select.Viewport>
            {options.map((r) => (
              <Select.Item className="mh-select-item" value={r.id} key={r.id}>
                <Select.ItemText>{r.namespace || r.name}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
