import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Zap } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";
import type { AgentModelCatalog, AgentModelOption } from "../app-settings/types";

type PickerView = "settings" | "models" | "efforts";

function optionLabel(option: AgentModelOption): string {
  return option.label || option.model;
}

export function TaskModelSelector({
  catalog,
  model,
  reasoningEffort,
  onSetModel,
  onSetReasoningEffort,
}: {
  catalog: AgentModelCatalog;
  model?: string;
  reasoningEffort?: string;
  onSetModel: (model: string | undefined) => void;
  onSetReasoningEffort: (effort: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("settings");
  const options = useMemo(() => {
    if (!model || catalog.models.some((option) => option.model === model)) {
      return catalog.models;
    }
    return [...catalog.models, { model, reasoningEfforts: [] }];
  }, [catalog.models, model]);
  const selectedOption = options.find((option) => option.model === model);
  const efforts = useMemo(() => {
    const configured = selectedOption?.reasoningEfforts ?? [];
    if (!reasoningEffort || configured.includes(reasoningEffort)) return configured;
    return [...configured, reasoningEffort];
  }, [reasoningEffort, selectedOption]);

  if (options.length === 0 && !model) return null;

  const modelLabel = selectedOption ? optionLabel(selectedOption) : t("newTask.modelDefault");
  const effortLabel = reasoningEffort || t("newTask.reasoningEffortAuto");
  const triggerLabel = reasoningEffort ? `${modelLabel} ${reasoningEffort}` : modelLabel;

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) setView("settings");
  }

  function selectModel(nextModel: string | undefined) {
    onSetModel(nextModel);
    const nextOption = options.find((option) => option.model === nextModel);
    if (
      reasoningEffort &&
      (!nextOption || !nextOption.reasoningEfforts.includes(reasoningEffort))
    ) {
      onSetReasoningEffort(undefined);
    }
    setView("settings");
  }

  function selectEffort(nextEffort: string | undefined) {
    onSetReasoningEffort(nextEffort);
    setView("settings");
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          style={
            open ? s.taskModelCompactTriggerOpen : s.taskModelCompactTrigger
          }
          aria-label={`${t("newTask.model")}: ${triggerLabel}`}
          title={selectedOption?.model}
        >
          <Zap size={15} strokeWidth={2.2} fill="currentColor" style={s.taskModelCompactIcon} />
          <span style={s.taskModelCompactName}>{modelLabel}</span>
          {reasoningEffort && (
            <span style={s.taskModelCompactEffort}>{reasoningEffort}</span>
          )}
          <ChevronDown size={14} strokeWidth={2.2} style={s.taskModelCompactChevron} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          style={s.taskModelPopoverContent}
        >
          {view === "settings" && (
            <div style={s.taskModelSettingsList}>
              <button
                type="button"
                className="branch-popover-item"
                style={s.taskModelSettingsRow}
                onClick={() => setView("models")}
              >
                <span style={s.taskModelSettingsLabel}>{t("newTask.model")}</span>
                <span style={s.taskModelSettingsTrailing}>
                  <span style={s.taskModelSettingsValue}>{modelLabel}</span>
                  <ChevronRight size={14} strokeWidth={2} />
                </span>
              </button>

              <button
                type="button"
                className="branch-popover-item"
                style={
                  efforts.length > 0
                    ? s.taskModelSettingsRow
                    : s.taskModelSettingsRowDisabled
                }
                disabled={efforts.length === 0}
                onClick={() => setView("efforts")}
              >
                <span style={s.taskModelSettingsLabel}>
                  {t("newTask.reasoningEffort")}
                </span>
                <span style={s.taskModelSettingsTrailing}>
                  <span style={s.taskModelSettingsValue}>{effortLabel}</span>
                  <ChevronRight size={14} strokeWidth={2} />
                </span>
              </button>
            </div>
          )}

          {view === "models" && (
            <>
              <button
                type="button"
                className="branch-popover-item"
                style={s.taskModelSubmenuHeader}
                onClick={() => setView("settings")}
              >
                <ChevronLeft size={14} strokeWidth={2} />
                <span>{t("newTask.model")}</span>
              </button>
              <div style={s.taskModelPopoverSeparator} />
              <div style={s.taskModelPopoverList}>
                <button
                  type="button"
                  className="branch-popover-item"
                  style={!model ? s.taskModelPopoverItemSelected : s.taskModelPopoverItem}
                  aria-pressed={!model}
                  onClick={() => selectModel(undefined)}
                >
                  <span style={s.taskModelPopoverItemBody}>
                    <span style={s.taskModelPopoverItemName}>
                      {t("newTask.modelDefault")}
                    </span>
                  </span>
                  {!model && <Check size={14} strokeWidth={2.2} />}
                </button>

                {options.map((option) => {
                  const selected = option.model === model;
                  return (
                    <button
                      key={option.model}
                      type="button"
                      className="branch-popover-item"
                      style={
                        selected ? s.taskModelPopoverItemSelected : s.taskModelPopoverItem
                      }
                      aria-pressed={selected}
                      onClick={() => selectModel(option.model)}
                    >
                      <span style={s.taskModelPopoverItemBody}>
                        <span style={s.taskModelPopoverItemName}>{optionLabel(option)}</span>
                        {option.label && option.label !== option.model && (
                          <span style={s.taskModelPopoverItemMeta}>{option.model}</span>
                        )}
                      </span>
                      {selected && <Check size={14} strokeWidth={2.2} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {view === "efforts" && (
            <>
              <button
                type="button"
                className="branch-popover-item"
                style={s.taskModelSubmenuHeader}
                onClick={() => setView("settings")}
              >
                <ChevronLeft size={14} strokeWidth={2} />
                <span>{t("newTask.reasoningEffort")}</span>
              </button>
              <div style={s.taskModelPopoverSeparator} />
              <div style={s.taskModelPopoverList}>
                <button
                  type="button"
                  className="branch-popover-item"
                  style={
                    !reasoningEffort
                      ? s.taskModelPopoverItemSelected
                      : s.taskModelPopoverItem
                  }
                  aria-pressed={!reasoningEffort}
                  onClick={() => selectEffort(undefined)}
                >
                  <span>{t("newTask.reasoningEffortAuto")}</span>
                  {!reasoningEffort && <Check size={14} strokeWidth={2.2} />}
                </button>
                {efforts.map((effort) => {
                  const selected = effort === reasoningEffort;
                  return (
                    <button
                      key={effort}
                      type="button"
                      className="branch-popover-item"
                      style={
                        selected ? s.taskModelPopoverItemSelected : s.taskModelPopoverItem
                      }
                      aria-pressed={selected}
                      onClick={() => selectEffort(effort)}
                    >
                      <span>{effort}</span>
                      {selected && <Check size={14} strokeWidth={2.2} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
