import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, GitBranch, Trash2, X } from "lucide-react";

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

/** dry-run 扫描出的待删除候选，等待用户在确认框里拍板。 */
interface PendingCandidate {
  repo: string;
  branch: string;
  reason: string;
}

interface PendingPrune {
  candidates: PendingCandidate[];
  /** 不满足删除条件、会被自动跳过的分支数。 */
  skipped: number;
}

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

/** 清理失效分支前的确认框。
 *
 *  用应用内 Radix 弹层而不是 `plugin-dialog` 的原生 `confirm()`：原生框吃不下长分支名
 *  （等宽换行后几乎读不出 `仓库:分支` 的边界），也无法跟随 nezha 主题。 */
function PruneConfirmDialog({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  pending: PendingPrune | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const candidates = pending?.candidates ?? [];
  const visible = candidates.slice(0, MAX_CONFIRM_LINES);
  const hidden = candidates.length - visible.length;
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        // 删除进行中不允许关掉弹层（后端已经在动分支了）。
        if (!open && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="build-dialog-overlay" />
        <Dialog.Content
          ref={contentRef}
          className="build-dialog"
          aria-describedby="build-dialog-lead"
          // 焦点落在弹层容器本身：避免打开瞬间给关闭按钮画出一圈「被选中」的焦点环，
          // 也避免回车直接命中删除按钮。Tab 照常进入按钮序列。
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            contentRef.current?.focus();
          }}
        >
          <div className="build-dialog-head">
            <span className="build-dialog-icon">
              <AlertTriangle size={15} />
            </span>
            <Dialog.Title className="build-dialog-title">清理失效分支</Dialog.Title>
            <Dialog.Close className="build-dialog-close" aria-label="关闭" disabled={busy}>
              <X size={14} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="build-dialog-lead" id="build-dialog-lead">
            将删除 <strong>{candidates.length}</strong> 个远端已不存在的本地分支：
          </Dialog.Description>
          <div className="build-dialog-list">
            {visible.map((c) => (
              <div key={`${c.repo}:${c.branch}`} className="build-dialog-item">
                <span className="build-dialog-item-name">
                  <GitBranch size={11} />
                  <span className="build-dialog-item-repo">{c.repo}</span>
                  <span className="build-dialog-item-sep">:</span>
                  <span className="build-dialog-item-branch">{c.branch}</span>
                </span>
                <span className="build-dialog-item-reason">{c.reason}</span>
              </div>
            ))}
            {hidden > 0 && <div className="build-dialog-more">… 其余 {hidden} 个</div>}
          </div>
          <div className="build-dialog-note">
            {pending !== null && pending.skipped > 0 && (
              <p>另有 {pending.skipped} 个分支不满足删除条件，会自动跳过。</p>
            )}
            <p>仅删除提交已存在于远端分支的本地分支；有未提交内容 / 未合并的分支不会被删除。</p>
          </div>
          <div className="build-dialog-actions">
            <button className="rp-btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <button className="rp-btn" data-variant="danger" onClick={onConfirm} disabled={busy}>
              {busy ? "删除中…" : `删除 ${candidates.length} 个分支`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
  const [pending, setPending] = useState<PendingPrune | null>(null);

  const selectedNames = () => repos.filter((r) => selected.has(r.name)).map((r) => r.name);
  const disabled = busy || pending !== null || selectedNames().length === 0;

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
        r.branches
          .filter((b) => b.deletable)
          .map((b) => ({ repo: r.name, branch: b.branch, reason: b.reason })),
      );
      const skipped = scan.reduce((n, r) => n + r.branches.filter((b) => !b.deletable).length, 0);
      if (candidates.length === 0) {
        setResults(scan);
        return;
      }
      setPending({ candidates, skipped });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [projectPath, repos, selected]);

  const handleConfirm = useCallback(async () => {
    const names = repos.filter((r) => selected.has(r.name)).map((r) => r.name);
    if (names.length === 0) return;
    setError("");
    setBusy(true);
    try {
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
      setPending(null);
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
      <PruneConfirmDialog
        pending={pending}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void handleConfirm()}
      />
    </div>
  );
}
