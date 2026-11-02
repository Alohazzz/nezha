import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, X } from "lucide-react";
import type {
  AddPlanResult,
  DeliveryPlan,
  PlanIssue,
  YunxiaoWorkitem,
} from "../../types";
import type { YunxiaoSettings } from "../app-settings/types";
import s from "../../styles";
import { SelectField } from "../yunxiao/SelectField";

/** 毫秒时间戳 → 本地日期（yyyy/MM/dd），计划选择器与回写提示共用。 */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

/** 摘要四分组的一行：标签 + 议题编号列表（失败组带原因、红显）。 */
function SummaryRow({
  label,
  entries,
  danger,
}: {
  label: string;
  entries: { serialNumber: string; reason?: string }[];
  danger?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <div style={s.bbSummaryRow}>
      <span style={s.bbSummaryLabel}>
        {label} {entries.length}：
      </span>
      <span style={danger ? s.bbSummaryItemsDanger : s.bbSummaryItems}>
        {entries
          .map((o) => (o.reason ? `${o.serialNumber}（${o.reason}）` : o.serialNumber))
          .join("、")}
      </span>
    </div>
  );
}

/** 云效议题「添加到计划」：选目标计划（本项目活跃计划）后写入成员（有序追加）。
 *  单计划归属（S1）：已属其它计划的议题由后端逐条拒绝并在摘要里明示。
 *  云效同步：后端预检三分类（issue #121）——已属其它计划拒绝；已是「待开发」
 *  视为已加入（跳过回写、仅补本地归属）；正常回写（负责人 / 计划开始时间 /
 *  「待开发」状态），遇错即停。部分失败返回 partial 摘要：弹结果清单 + 只补
 *  失败/未处理条目的一键重试；全部成功直接关弹窗刷新。计划完成时间不回写，
 *  归用户在云效侧维护。 */
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
  const [retryIssues, setRetryIssues] = useState<YunxiaoWorkitem[] | null>(null);
  const [summary, setSummary] = useState<AddPlanResult["summary"] | null>(null);
  // 摘要态展示的议题集合：首次为全量，重试后收缩为失败/未处理子集。
  const activeIssues = retryIssues ?? issues;

  const runAdd = async (targets: YunxiaoWorkitem[]) => {
    if (!planId || busy) return;
    if (!settings.token || !settings.organizationId) {
      setError("未连接云效，请先在设置中配置令牌");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const members: PlanIssue[] = targets.map((issue) => ({
        workitemId: issue.id,
        serialNumber: issue.serialNumber,
        subject: issue.subject,
        category: issue.categoryId ?? "",
      }));
      const result = await invoke<AddPlanResult>("add_delivery_plan_issues", {
        projectId,
        planId,
        issues: members,
        token: settings.token,
        organizationId: settings.organizationId,
      });
      // 计划成员（含跳过补归属的部分）已落盘，父级必须同步，避免计划视图缺条目。
      onAdded(result.plan);
      if (result.summary.partial) {
        setSummary(result.summary);
        // 重试集 = 回写失败 + 未处理（均可重试）；「已属其它计划」这类
        // 不可重试拒绝（retryable=false）排除，避免重试死循环。
        const retryableIds = new Set(
          [...result.summary.failed, ...result.summary.pending]
            .filter((o) => o.retryable !== false)
            .map((o) => o.workitemId),
        );
        setRetryIssues(
          targets.filter((i) => retryableIds.has(i.id)),
        );
      } else {
        onClose();
      }
    } catch (e) {
      // 硬失败（状态拉不到 / 计划不存在等）：无部分成功语义，维持整批错误提示。
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => void runAdd(activeIssues);

  const retry = () => {
    setSummary(null);
    void runAdd(retryIssues ?? []);
  };

  const retryCount = summary
    ? [...summary.failed, ...summary.pending].filter((o) => o.retryable !== false)
        .length
    : 0;

  return (
    <div style={s.bbDialogOverlay}>
      <div style={s.bbDialog}>
        <div style={s.bbDialogTitle}>添加到计划</div>
        {!summary && (
          <>
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
              将加入 {activeIssues.length} 个议题：
              {activeIssues.map((i) => i.serialNumber).join("、")}
              。顺序＝当前勾选顺序。加入时会把计划开始时间（默认当天）、负责人（当前用户）
              写入云效，议题状态置为「待开发」；已在计划中的议题自动跳过。
            </div>
          </>
        )}
        {summary && (
          <div style={s.bbSummaryBlock}>
            <SummaryRow label="✅ 成功" entries={summary.succeeded} />
            <SummaryRow label="⏭ 无需处理（已加入）" entries={summary.skipped} />
            <SummaryRow label="❌ 失败" entries={summary.failed} danger />
            <SummaryRow label="⏸ 未处理" entries={summary.pending} danger />
            <div style={s.bbCheckHint}>
              成功与跳过的议题已写入计划；失败/未处理的可在云效侧核对后重试。
            </div>
          </div>
        )}
        {error && <div style={s.bbError}>{error}</div>}
        <div style={s.bbDialogActions}>
          {summary ? (
            <>
              <button type="button" style={s.bbBtnGhost} onClick={onClose}>
                <X size={13} />
                关闭
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={busy || retryCount === 0}
                onClick={retry}
              >
                <RotateCcw size={13} />
                {busy ? "重试中…" : `重试失败+未处理（${retryCount}）`}
              </button>
            </>
          ) : (
            <>
              <button type="button" style={s.bbBtnGhost} onClick={onClose}>
                <X size={13} />
                取消
              </button>
              <button
                type="button"
                style={s.bbBtnPrimary}
                disabled={!planId || busy}
                onClick={submit}
              >
                {busy ? "加入中…" : "加入"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
