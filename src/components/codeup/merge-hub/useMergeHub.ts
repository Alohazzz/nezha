import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { appConfirm } from "../../AppConfirmDialog";
import type { CodeupMr, CodeupRepository, CodeupReviewFinding } from "../../../types";
export type StartCodeupTask = (
  mr: CodeupMr,
  kind: "review" | "conflict" | "merge",
) => void | Promise<void>;
export type MergeAction = "pull" | "review" | "merge" | "close";
export function useMergeHub(onStart: StartCodeupTask) {
  const [repos, setRepos] = useState<CodeupRepository[]>([]);
  const [repoFilter, setRepoFilter] = useState("all");
  const [state, setState] = useState<"opened" | "closed">("opened");
  const [mrs, setMrs] = useState<CodeupMr[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [repoError, setRepoError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<{ id: string; action: MergeAction } | null>(null);
  const lock = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [invalidate]);
  const load = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const list = await invoke<CodeupMr[]>("codeup_list_pending_mrs", {
        repositoryId: repoFilter === "all" ? null : repoFilter,
        state,
      });
      if (mounted.current && request === generation.current) setMrs(list);
    } catch (e) {
      if (mounted.current && request === generation.current) {
        setError(String(e));
        setMrs([]);
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, [repoFilter, state]);
  const loadRepos = useCallback(async () => {
    try {
      const list = await invoke<CodeupRepository[]>("codeup_list_repositories");
      if (mounted.current) {
        setRepos(list);
        setRepoError("");
      }
    } catch (e) {
      if (mounted.current) setRepoError(`仓库筛选加载失败：${String(e)}`);
    }
  }, []);
  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);
  useEffect(() => {
    void load();
    return () => {
      invalidate();
    };
  }, [load, invalidate]);
  // Invalidate an older GET before mutation so it cannot resurrect a closed MR.
  async function run(mr: CodeupMr, action: MergeAction) {
    if (lock.current) return false;
    lock.current = true;
    generation.current++;
    setLoading(false);
    setBusy({ id: mr.id, action });
    setNotice("");
    setError("");
    try {
      if (action === "close") {
        await invoke<void>("codeup_close_mr", {
          repositoryId: mr.repositoryId,
          mrId: String(mr.localId),
        });
        if (mounted.current) {
          setMrs((prev) => prev.filter((item) => item.id !== mr.id));
          setNotice(`合并请求 #${mr.localId} 已关闭，可在「已关闭」中查看。`);
        }
      } else if (action === "pull") {
        const path = await invoke<string>("codeup_pull_code", {
          repository: mr.repository,
          sourceBranch: mr.sourceBranch,
          targetBranch: mr.targetBranch,
          mrId: String(mr.localId),
        });
        if (mounted.current) {
          setMrs((prev) =>
            prev.map((item) =>
              item.id === mr.id ? { ...item, pulled: true, worktreePath: path } : item,
            ),
          );
          setNotice("已拉取代码到本地 worktree。");
        }
      } else {
        if (action === "merge") {
          if (!mr.pulled) throw new Error("请先拉取代码，再执行分支合并。");
          // Keep the existing non-blocking findings safety net.
          let findings: CodeupReviewFinding[] | null = null;
          try {
            findings = await invoke<CodeupReviewFinding[] | null>("codeup_read_review", {
              repository: mr.repository,
              mrId: String(mr.localId),
            });
          } catch (e) {
            console.warn("[merge-hub] review findings unavailable", e);
          }
          const failed = (findings ?? []).filter((f) => f.status === "fail");
          if (
            failed.length &&
            !(await appConfirm(
              `审查判定存在 ${failed.length} 处 fail（阻止级）标记（如「${failed[0].rule}」），仍要交给 Agent 合并？`,
              { title: "合并确认", kind: "warning" },
            ))
          )
            return false;
        }
        await onStart(mr, action);
        if (mounted.current)
          setNotice(action === "review" ? "已启动代码审查任务。" : "已启动分支合并任务。");
      }
      return true;
    } catch (e) {
      if (action === "close") throw e;
      if (mounted.current) setError(String(e));
      return false;
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  return {
    repos,
    repoFilter,
    setRepoFilter,
    state,
    setState,
    mrs,
    loading,
    error,
    repoError,
    notice,
    busy,
    run,
    refresh: () => {
      if (!lock.current) {
        void load();
        void loadRepos();
      }
    },
  };
}
