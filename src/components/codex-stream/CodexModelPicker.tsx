import { useEffect, useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronLeft, Zap } from "lucide-react";
import { useI18n } from "../../i18n";
import { invoke } from "@tauri-apps/api/core";
import {
  APP_SETTINGS_CHANGED_EVENT,
  type AppSettings,
  type AgentModelCatalog,
} from "../app-settings/types";

type PickerView = "models" | "efforts";

/** 目录模型未配 effort 时的兜底档（上游 ReasoningEffort 枚举全集）。 */
const FALLBACK_EFFORTS = ["minimal", "low", "medium", "high"] as const;

function optionLabel(option: { model: string; label?: string }): string {
  return option.label || option.model;
}

/**
 * structured composer 的 `/model` `/effort` 选择浮层（对齐 Codex CLI TUI 同名
 * 内置命令）。与 NewTaskView 的 TaskModelSelector 同一套样式资产，但：
 * - 无触发按钮——宿主（CodexComposer）在用户于 `/` 弹层选中内置命令后打开，
 *   Radix Popover.Anchor 锚在 composer 底部框上；
 * - 受控 open：选中/关闭即回报宿主；写入经 `onSetModel` / `onSetEffort`
 *   上抛（App 层负责调 `set_codex_structured_model` 并持久化任务快照）。
 */
export function CodexModelPicker({
  view,
  catalog,
  model,
  reasoningEffort,
  onClose,
  onSetModel,
  onSetEffort,
}: {
  /** 打开时的初始视图：/model → models，/effort → efforts。 */
  view: PickerView;
  catalog: AgentModelCatalog;
  model?: string;
  reasoningEffort?: string;
  onClose: () => void;
  onSetModel: (model: string | undefined) => void;
  onSetEffort: (effort: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [activeView, setActiveView] = useState<PickerView>(view);
  useEffect(() => {
    setOpen(true);
    setActiveView(view);
  }, [view]);

  const [currentCatalog, setCurrentCatalog] = useState(catalog);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    invoke<AppSettings>("refresh_agent_model_catalog", { agent: "codex" })
      .then((settings) => {
        if (cancelled) return;
        setCurrentCatalog(settings.codex_model_catalog);
        window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // A saved selection from a previous provider is only a label, never a candidate.
  const options = loading || error ? [] : currentCatalog.models;
  const selectedOption = options.find((option) => option.model === model);
  const efforts = useMemo(() => {
    if (activeView !== "efforts") return [];
    const configured = selectedOption?.reasoningEfforts ?? [];
    if (configured.length === 0) return [...FALLBACK_EFFORTS];
    return reasoningEffort && !configured.includes(reasoningEffort)
      ? [...configured, reasoningEffort]
      : configured;
  }, [activeView, reasoningEffort, selectedOption]);

  const modelLabel = selectedOption
    ? optionLabel(selectedOption)
    : model || t("newTask.modelDefault");

  function close() {
    setOpen(false);
    onClose();
  }

  function selectModel(nextModel: string | undefined) {
    onSetModel(nextModel);
    // 换模型后原 effort 未必被新模型支持：与 TaskModelSelector 同策略清掉
    const nextOption = options.find((option) => option.model === nextModel);
    if (
      reasoningEffort &&
      nextOption &&
      nextOption.reasoningEfforts.length > 0 &&
      !nextOption.reasoningEfforts.includes(reasoningEffort)
    ) {
      onSetEffort(undefined);
    }
    close();
  }

  function selectEffort(nextEffort: string | undefined) {
    onSetEffort(nextEffort);
    close();
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      {/* 锚满 composer 容器（宿主 wrap 是 position:relative）：浮层 side="top"
          align="end" 时贴容器右上沿弹出，与 composer 可视框对齐——Anchor 是
          0x0 空元素，不撑满就落在容器左上角。 */}
      <Popover.Anchor className="codex-model-picker-anchor" />
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="end"
          sideOffset={6}
          className="codex-model-picker"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {loading ? (
            <div role="status" className="codex-model-picker-status">
              {t("appSettings.models.syncing")}
            </div>
          ) : error ? (
            <div className="codex-model-picker-status">
              <div role="alert">{error}</div>
              <button
                type="button"
                className="branch-popover-item"
                onClick={() => setRefreshKey((key) => key + 1)}
              >
                {t("appSettings.models.sync")}
              </button>
            </div>
          ) : activeView === "models" ? (
            <>
              <div className="codex-model-picker-header">{t("newTask.model")}</div>
              <div className="codex-model-picker-separator" />
              <div className="codex-model-picker-list">
                <button
                  type="button"
                  className="branch-popover-item codex-model-picker-item"
                  aria-pressed={!model}
                  onClick={() => selectModel(undefined)}
                >
                  <span className="codex-model-picker-body">
                    <span className="codex-model-picker-name">{t("newTask.modelDefault")}</span>
                  </span>
                  {!model && <Check size={14} strokeWidth={2.2} />}
                </button>
                {options.map((option) => {
                  const selected = option.model === model;
                  return (
                    <button
                      key={option.model}
                      type="button"
                      className="branch-popover-item codex-model-picker-item"
                      aria-pressed={selected}
                      onClick={() => selectModel(option.model)}
                    >
                      <span className="codex-model-picker-body">
                        <span className="codex-model-picker-name">{optionLabel(option)}</span>
                        {option.label && option.label !== option.model && (
                          <span className="codex-model-picker-meta">{option.model}</span>
                        )}
                      </span>
                      {selected && <Check size={14} strokeWidth={2.2} />}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                className="branch-popover-item codex-model-picker-header"
                onClick={() => setActiveView("models")}
              >
                <ChevronLeft size={14} strokeWidth={2} />
                <span>{t("newTask.reasoningEffort")}</span>
              </button>
              <div className="codex-model-picker-separator" />
              <div className="codex-model-picker-list">
                <button
                  type="button"
                  className="branch-popover-item codex-model-picker-item"
                  aria-pressed={!reasoningEffort}
                  onClick={() => selectEffort(undefined)}
                >
                  <span className="codex-model-picker-body">
                    <span className="codex-model-picker-name">
                      {t("newTask.reasoningEffortAuto")}
                    </span>
                  </span>
                  {!reasoningEffort && <Check size={14} strokeWidth={2.2} />}
                </button>
                {efforts.map((effort) => {
                  const selected = effort === reasoningEffort;
                  return (
                    <button
                      key={effort}
                      type="button"
                      className="branch-popover-item codex-model-picker-item"
                      aria-pressed={selected}
                      onClick={() => selectEffort(effort)}
                    >
                      <span className="codex-model-picker-body">
                        <span className="codex-model-picker-name">
                          <Zap
                            size={12}
                            strokeWidth={2.2}
                            fill="currentColor"
                            className="codex-model-picker-icon"
                          />{" "}
                          {effort}
                        </span>
                      </span>
                      {selected && <Check size={14} strokeWidth={2.2} />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {/* modelLabel 仅在 models 视图头部回显当前值（与 header 标签并存） */}
          {activeView === "models" && (
            <div className="codex-model-picker-current" title={selectedOption?.model}>
              {modelLabel}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
