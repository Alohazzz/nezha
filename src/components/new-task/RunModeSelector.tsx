import { Layers, ChevronDown } from "lucide-react";
import * as Select from "@radix-ui/react-select";
import type { TaskRunMode } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";

const MODES: TaskRunMode[] = ["pty", "structured"];

/**
 * Codex 任务的运行通道选择（issue #116 阶段 3.4）：pty = 终端 TUI（默认），
 * structured = app-server 结构化卡片视图。选择经 localStorage 记忆（调用方负责），
 * 仅 agent=codex 时渲染。
 */
export function RunModeSelector({
  runMode,
  onSetRunMode,
}: {
  runMode: TaskRunMode;
  onSetRunMode: (mode: TaskRunMode) => void;
}) {
  const { t } = useI18n();

  function modeLabel(mode: TaskRunMode) {
    return mode === "pty" ? t("codex.runMode.pty") : t("codex.runMode.structured");
  }

  return (
    <Select.Root value={runMode} onValueChange={(v) => onSetRunMode(v as TaskRunMode)}>
      <Select.Trigger style={s.toolbarBtn} aria-label={t("codex.runMode")}>
        <Layers size={13} strokeWidth={2} color="var(--text-muted)" />
        <span>{modeLabel(runMode)}</span>
        <Select.Icon>
          <ChevronDown size={12} strokeWidth={2.5} style={s.dimChevronIcon} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content position="popper" sideOffset={6} style={s.toolbarMenuContent}>
          <Select.Viewport>
            {MODES.map((mode) => (
              <Select.Item
                key={mode}
                value={mode}
                className="branch-popover-item"
                style={s.toolbarMenuItem}
              >
                <Select.ItemText>{modeLabel(mode)}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
