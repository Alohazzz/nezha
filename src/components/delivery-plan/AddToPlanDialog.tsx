import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import type { DeliveryPlan, PlanIssue, YunxiaoWorkitem } from "../../types";
import s from "../../styles";

/** 云效议题「添加到计划」：选目标计划（本项目活跃计划）后写入成员（有序追加）。
 *  单计划归属（S1）：已属其它计划的议题由后端整体拒绝并明示。 */
export function AddToPlanDialog({
  issues,
  projectId,
  deliveryPlans,
  onAdded,
  onClose,
}: {
  issues: YunxiaoWorkitem[];
  projectId: string;
  deliveryPlans: DeliveryPlan[];
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
    setBusy(true);
    setError("");
    try {
      const members: PlanIssue[] = issues.map((issue) => ({
        workitemId: issue.id,
        serialNumber: issue.serialNumber,
        subject: issue.subject,
        category: issue.categoryId ?? "",
      }));
      const plan = await invoke<DeliveryPlan>("add_delivery_plan_issues", {
        projectId,
        planId,
        issues: members,
      });
      onAdded(plan);
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
            <select
              style={s.bbInput}
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.branch}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={s.bbCheckHint}>
          将加入 {issues.length} 个议题：{issues.map((i) => i.serialNumber).join("、")}
          。顺序＝当前勾选顺序。
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
