import { useI18n } from "../../../i18n";

/**
 * 方案执行「无人值守」开关（预览页头部与生成待办确认页共用）。
 *
 * 勾选后：生成的待办一律进 `waiting_deps` 由串行调度驱动，且权限被强制为
 * `full_access`（无人点审批）——见 `utils/planQueue.resolvePlanTodoLaunch`。
 * 任务跑完一轮（hook `Stop` → `awaiting_review`）即自动收尾，整链无需点击。
 */
export function UnattendedToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={t("plan.unattended.toggle")}
      title={t("plan.unattended.hint")}
      disabled={disabled}
      data-checked={checked}
      data-disabled={disabled === true}
      onClick={() => onChange(!checked)}
      className="app-settings-toggle plan-unattended-toggle"
    >
      <span className="app-settings-toggle-label">{t("plan.unattended.label")}</span>
      <span className="app-settings-toggle-track">
        <span className="app-settings-toggle-knob" />
      </span>
    </button>
  );
}

/** 勾选无人值守后随行的 YOLO 提示（放在设置行内，占满剩余宽度）。 */
export function UnattendedHint() {
  const { t } = useI18n();
  return <span className="plan-unattended-hint">{t("plan.unattended.hint")}</span>;
}
