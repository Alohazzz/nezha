import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil } from "lucide-react";
import type { DeliveryPlan } from "../../types";
import s from "../../styles";
import { SelectField } from "../yunxiao/SelectField";

interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string | null;
}

/** 去掉远端前缀：`origin/develop` → `develop`（列表只列分支名，避免 origin/HEAD 之类噪音）。 */
function localizeBranchName(name: string): string {
  const idx = name.indexOf("/");
  return idx > 0 ? name.slice(idx + 1) : name;
}

/** 计划详情分支行的「合并回目标分支」编辑器。
 *
 *  计划创建时允许把目标分支留空，但空目标会让「提交 MR」被静默禁用、且此前没有补记入口——
 *  存量计划就此锁死。这里把分支行的目标段做成可点编辑：选中真实存在的分支后回写后端，
 *  按钮随 `targetBranch` 就地解禁。
 *
 *  仅进行中的计划可编辑（`review` / `merged` / `closed` 已固化目标，改它会让 MR 目标与记录
 *  不一致）。 */
export function TargetBranchEditor({
  plan,
  projectPath,
  onUpdated,
}: {
  plan: DeliveryPlan;
  projectPath: string;
  onUpdated: (plan: DeliveryPlan) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const editable = plan.status === "active";

  // 打开编辑器才去拉分支列表：详情页常驻，不该为每个计划都跑一次 git。
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    invoke<BranchInfo[]>("git_list_branches", {
      projectPath,
      repoPath: plan.worktreeRepo ?? null,
    })
      .then((list) => {
        if (cancelled) return;
        const names = list
          .filter((b) => !b.name.startsWith("remotes/"))
          .map((b) => (b.remote ? localizeBranchName(b.name) : b.name))
          .filter((n) => n.length > 0 && n !== plan.branch);
        // 本地 ∪ 远端去重，稳定排序便于选择。
        setBranches([...new Set(names)].sort());
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [editing, projectPath, plan.worktreeRepo, plan.branch]);

  const options = useMemo(() => branches.map((b) => ({ value: b, label: b })), [branches]);

  const commit = useCallback(
    async (branch: string) => {
      if (!branch || branch === plan.targetBranch) {
        setEditing(false);
        return;
      }
      setBusy(true);
      setError("");
      try {
        const updated = await invoke<DeliveryPlan>("update_delivery_plan_target", {
          projectId: plan.projectId,
          projectPath,
          repoPath: plan.worktreeRepo ?? null,
          planId: plan.id,
          targetBranch: branch,
        });
        onUpdated(updated);
        setEditing(false);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [plan.projectId, plan.id, plan.targetBranch, plan.worktreeRepo, projectPath, onUpdated],
  );

  if (!editable) {
    return <span>{plan.targetBranch || "（未指定合并目标）"}</span>;
  }

  if (editing) {
    return (
      <span style={s.dpTargetEdit}>
        <SelectField
          value={plan.targetBranch}
          onChange={(v) => void commit(v)}
          options={options}
          placeholder={busy ? "保存中…" : "选择目标分支"}
          disabled={busy}
          triggerStyle={s.dpTargetSelectTrigger}
        />
        {error && <span style={s.dpTargetError}>{error}</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      style={plan.targetBranch ? s.dpTargetBtn : s.dpTargetBtnEmpty}
      title="点击补记 / 修改合并回目标分支"
      onClick={() => setEditing(true)}
    >
      {plan.targetBranch || "（未指定合并目标）"}
      <Pencil size={11} strokeWidth={2} />
    </button>
  );
}
