import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { DeliveryPlan, PlanIssue, YunxiaoWorkitem } from "../../types";
import type { YunxiaoSettings } from "../app-settings/types";
import s from "../../styles";
import { SelectField } from "../yunxiao/SelectField";

/** 毫秒时间戳 → 本地日期（yyyy/MM/dd），计划选择器与回写提示共用。 */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 云效议题「添加到计划」：选目标计划（本项目活跃计划）后写入成员（有序追加）。
 *  单计划归属（S1）：已属其它计划的议题由后端整体拒绝并明示。
 *  云效同步：后端在入列前逐条校验「已是待开发不可添加」，并把计划的完成时间、
 *  当前令牌用户（负责人）与「待开发」状态回写到议题——任一失败整批阻断。 */
export function AddToPlanDialog({
  issues,
  projectId,
  deliveryPlans,
  settings,
  onAdded,
  onClose,
}: {
  issues: YunxiaoWorkitem[];
  projectId: string;
  deliveryPlans: DeliveryPlan[];
  settings: YunxiaoSettings;
  onAdded: (plan: DeliveryPlan) => void;
  onClose: () => void;
}) {
  const candidates = deliveryPlans.filter(
    (p) =>
      p.projectId === projectId && (p.status === "active" || p.status === "review"),
  );
  const [planId, setPlanId] = useState(candidates[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!planId || busy) return;
    const plan = candidates.find((p) => p.id === planId);
    if (!settings.token || !settings.organizationId) {
      setError("未连接云效，请先在设置中配置令牌");
      return;
    }
    if (!plan?.planEndDate) {
      setError("所选计划缺少计划完成时间（旧计划请重建），无法回写云效");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const members: PlanIssue[] = issues.map((issue) => ({
        workitemId: issue.id,
        serialNumber: issue.serialNumber,
        subject: issue.subject,
        category: issue.categoryId ?? "",
      }));
      const updated = await invoke<DeliveryPlan>("add_delivery_plan_issues", {
        projectId,
        planId,
        issues: members,
        token: settings.token,
        organizationId: settings.organizationId,
        planEndDate: plan.planEndDate,
      });
      onAdded(updated);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.bbDialog}>
        <div style={s.bbDialogTitle}>添加到计划</div>
        <div style={s.bbField}>
          <span style={s.bbFieldLabel}>目标计划（本项目）</span>
          {candidates.length === 0 ? (
            <div style={s.bbCheckHint}>本项目暂无进行中的计划，请先「创建计划」</div>
          ) : (
            <SelectField
              value={planId}
              onChange={setPlanId}
              options={candidates.map((p) => ({
                value: p.id,
                label: `${p.name} · ${p.planEndDate ? formatDate(p.planEndDate) : "无完成时间"}`,
              }))}
              placeholder="选择计划"
            />
          )}
        </div>
        <div style={s.bbCheckHint}>
          将加入 {issues.length} 个议题：{issues.map((i) => i.serialNumber).join("、")}
          。顺序＝当前勾选顺序。加入时会把计划完成时间、计划开始时间（默认当天）、
          负责人（当前用户）写入云效，议题状态置为「待开发」；已是「待开发」的议题会被拒绝。
        </div>
        {error && <div style={s.bbError}>{error}</div>}
        <div style={s.bbDialogActions}>
          <button type="button" style={s.bbBtnGhost} onClick={onClose}>
            <X size={13} />
            取消
          </button>
          <button
            type="button"
            style={s.bbBtnPrimary}
            disabled={!planId || busy}
            onClick={() => void submit()}
          >
            {busy ? "加入中…" : "加入"}
          </button>
        </div>
      </div>
    </div>
  );
}
