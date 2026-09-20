import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { Trash2 } from "lucide-react";

/** 「远端已不存在的本地分支」单项结果（对齐后端 `StaleBranchItem`）。 */
interface StaleBranchItem {
  branch: string;
  deleted: boolean;
  deletable: boolean;
  reason: string;
}

/** 单个仓库的失效分支清理结果（对齐后端 `StaleBranchRepoResult`）。 */
interface StaleBranchRepoResult {
  name: string;
  path: string;
  ok: boolean;
  message: string;
  branches: StaleBranchItem[];
}

/** 已删除的分支：交父组件就地更新分支列表，避免重跑全量仓库发现。 */
export interface DeletedBranch {
  repoPath: string;
  branch: string;
}

/** 明细行上限：分支多时不至于把面板撑爆。 */
const MAX_LINES = 40;

/** 确认框里最多列出的候选分支条数。 */
const MAX_CONFIRM_LINES = 15;

type Line = { key: string; tone?: "ok" | "warn" | "error"; text: string };

function toLines(results: StaleBranchRepoResult[]): Line[] {
  const lines: Line[] = [];
  for (const repo of results) {
    if (!repo.ok) {
      lines.push({ key: repo.name, tone: "error", text: `× ${repo.name}：${repo.message}` });
      continue;
    }
    for (const item of repo.branches) {
      const head = item.deleted ? "✓ 已删除" : item.deletable ? "× 删除失败" : "· 跳过";
      lines.push({
        key: `${repo.name}/${item.branch}`,
        tone: item.deleted ? "ok" : item.deletable ? "error" : "warn",
        text: `${head} ${repo.name}:${item.branch} — ${item.reason}`,
      });
    }
  }
  return lines;
}

function summarize(results: StaleBranchRepoResult[]): string {
  const total = results.reduce((n, r) => n + r.branches.length, 0);
  const deleted = results.reduce((n, r) => n + r.branches.filter((b) => b.deleted).length, 0);
  const failed = results.reduce(
    (n, r) => n + r.branches.filter((b) => b.deletable && !b.deleted).length,
    0,
  );
  if (total === 0) return "未发现远端已不存在的本地分支";
  const skipped = total - deleted - failed;
  if (deleted === 0 && failed === 0) {
    return `没有可清理的失效分支（${skipped} 个不满足删除条件）`;
  }
  const parts: string[] = [];
  if (deleted > 0) parts.push(`已删除 ${deleted} 个`);
  if (failed > 0) parts.push(`删除失败 ${failed} 个`);
  if (skipped > 0) parts.push(`跳过 ${skipped} 个`);
  return parts.join(" · ");
}

/**
 * 清理「远端已不存在的本地分支」。
 *
 * 分两步：先 dry-run 扫描候选，弹确认框列出将要删除的分支；用户确认后才真正删除。
 * 删除条件由后端把关——只删提交已存在于远端分支的本地分支，
 * 有未提交内容 / 未合并 / 被 worktree 占用 / 受保护的分支一律只报跳过。
 */
export function StaleBranchCleanup({
  projectPath,
  repos,
  selected,
  onDeleted,
}: {
  projectPath: string;
  /** 面板当前可见的仓库（勾选按 name 匹配）。 */
  repos: { name: string; path: string }[];
  selected: Set<string>;
  /** 删除成功后回调，父组件据此移除对应分支。 */
  onDeleted?: (deleted: DeletedBranch[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<StaleBranchRepoResult[]>([]);
  const [error, setError] = useState("");

  const selectedNames = repos.filter((r) => selected.has(r.name)).map((r) => r.name);
  const disabled = busy || selectedNames.length === 0;

  const handlePrune = useCallback(async () => {
    const names = repos.filter((r) => selected.has(r.name)).map((r) => r.name);
    if (names.length === 0) return;
    setError("");
    setBusy(true);
    try {
      // 先扫描：dry-run 只判定候选，不动任何分支
      const scan = await invoke<StaleBranchRepoResult[]>("build_prune_stale_branches", {
        projectPath,
        selected: names,
        dryRun: true,
      });
      const candidates = scan.flatMap((r) =>
        r.branches.filter((b) => b.deletable).map((b) => `${r.name}:${b.branch}（${b.reason}）`),
      );
      const skipped = scan.reduce((n, r) => n + r.branches.filter((b) => !b.deletable).length, 0);
      if (candidates.length === 0) {
        setResults(scan);
        return;
      }
      const prompt = [`将删除 ${candidates.length} 个远端已不存在的本地分支：`, ""];
      prompt.push(...candidates.slice(0, MAX_CONFIRM_LINES));
      if (candidates.length > MAX_CONFIRM_LINES) {
        prompt.push(`… 其余 ${candidates.length - MAX_CONFIRM_LINES} 个`);
      }
      prompt.push("");
      if (skipped > 0) prompt.push(`另有 ${skipped} 个分支不满足删除条件，会自动跳过。`);
      prompt.push("仅删除提交已存在于远端分支的本地分支；有未提交内容 / 未合并的分支不会被删除。");
      const ok = await confirm(prompt.join("\n"), {
        title: "清理失效分支",
        kind: "warning",
      });
      if (!ok) return;

      const done = await invoke<StaleBranchRepoResult[]>("build_prune_stale_branches", {
        projectPath,
        selected: names,
        dryRun: false,
      });
      setResults(done);
      onDeleted?.(
        done.flatMap((r) =>
          r.branches.filter((b) => b.deleted).map((b) => ({ repoPath: r.path, branch: b.branch })),
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectPath, repos, selected, onDeleted]);

  const allLines = toLines(results);
  const lines = allLines.slice(0, MAX_LINES);

  return (
    <div className="build-stale">
      <button
        className="rp-btn"
        data-block="true"
        disabled={disabled}
        title="删除远端已不存在的本地分支（只删提交已存在于远端、且没有未提交内容的分支）"
        onClick={() => void handlePrune()}
      >
        <Trash2 size={12} />
        {busy ? "清理失效分支…" : "清理失效分支"}
      </button>
      <div className="build-meta">
        只清理远端已删除、且本地无未提交内容的本地分支；未合并或被 worktree 占用的分支会跳过。
      </div>
      {error && (
        <div className="build-status" data-tone="error">
          {error}
        </div>
      )}
      {results.length > 0 && (
        <div className="build-stale-result">
          <div className="build-meta">{summarize(results)}</div>
          {lines.map((l) => (
            <div key={l.key} className="build-status build-pull-line" data-tone={l.tone}>
              {l.text}
            </div>
          ))}
          {allLines.length > lines.length && (
            <div className="build-meta">… 共 {allLines.length} 条明细</div>
          )}
        </div>
      )}
    </div>
  );
}
