import { useMemo } from "react";
import type { Plan } from "../../../types";
import { appendableParentPlans } from "../../../utils/planBoard";
import { planTitle } from "../../../utils/plan";
import { SelectField } from "../SelectField";
import { useI18n } from "../../../i18n";
import s from "../../../styles";

/**
 * 「不关联」项的哨兵值。
 *
 * Radix 的 `Select.Item` **禁止空字符串 value**（空串被它保留表示「未选择 / 显示 placeholder」），
 * 传空串会在渲染期直接抛错、掀翻根 ErrorBoundary 把整页变成「Something went wrong」。
 * 因此下拉内部用哨兵值表示「不关联」，只有对外回调时才换回空串。
 */
const PARENT_NONE = "__none__";

/**
 * 「关联方案」字段：把本次这批议题挂成一个**已定稿方案的追加子方案**（决策 A2）。
 *
 * 候选由 `appendableParentPlans` 给出——本项目内、非 `draft`/`cancelled`/`archived`、
 * 排除正在创建的方案自身。无候选时整个字段不渲染（独立方案是默认路径，不该多一个空下拉）。
 *
 * 抽成独立组件是为了让 `PlanLaunchDialog` 不越过 AGENTS.md 的 400 行上限。
 */
export function PlanLaunchParentField({
  plans,
  targetProjectId,
  currentPlanId,
  value,
  onChange,
}: {
  plans: readonly Plan[];
  targetProjectId: string;
  /** 正在创建的 draft 方案 id（从候选里排除自身）。 */
  currentPlanId?: string;
  value: string;
  onChange: (planId: string) => void;
}) {
  const { t } = useI18n();
  const options = useMemo(
    () =>
      appendableParentPlans(plans, targetProjectId, currentPlanId).map((candidate) => ({
        value: candidate.id,
        label: planTitle(candidate),
      })),
    [plans, targetProjectId, currentPlanId],
  );

  if (options.length === 0) return null;

  return (
    <div style={s.planLaunchParent}>
      <label style={s.yunxiaoFieldLabel}>{t("plan.launch.parentLabel")}</label>
      <SelectField
        value={value || PARENT_NONE}
        onChange={(next) => onChange(next === PARENT_NONE ? "" : next)}
        options={[{ value: PARENT_NONE, label: t("plan.launch.parentNone") }, ...options]}
        placeholder={t("plan.launch.parentNone")}
      />
      <div style={s.planLaunchParentHint}>
        {value ? t("plan.launch.parentAppendHint") : t("plan.launch.parentHint")}
      </div>
    </div>
  );
}
