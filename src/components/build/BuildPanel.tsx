import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Hammer, RefreshCw, Play, X, GitBranch } from "lucide-react";
import s from "../../styles";

interface BuildRepo {
  name: string;
  path: string;
  remote: string;
  branch: string;
  branches: string[];
  is_submodule: boolean;
  dirty: boolean;
  missing: boolean;
}

interface BuildConfig {
  script_path: string;
  msbuild_path: string;
  solution: string;
  configuration: string;
  platform: string;
  external_dll_dir: string;
  skip_external_check: boolean;
  skip_restore: boolean;
  skip_clean: boolean;
  default_branch: string;
  max_parallel: number;
}

interface BuildState {
  last_built: Record<string, string>;
  updated_at?: string;
}

interface PullResult {
  name: string;
  ok: boolean;
  message: string;
}

interface PlanProject {
  Path: string;
  Name: string;
  Assembly: string;
  Stage: number;
  StageLabel: string;
  RefCount: number;
  Dependents?: string[];
}

interface Plan {
  Scope?: { TotalProjects?: number; CoreExcluded?: number; ToBuild?: number };
  Projects?: PlanProject[];
  StageOrder?: { Name: string; Label: string; Count: number }[];
  ExternalRefs?: {
    Dll: string;
    ReferencedBy: string;
    Exists: boolean;
    DeclaredVersion: string;
    ActualVersion: string;
    Type: string;
  }[];
  ExternalConflicts?: { Dll: string; Versions: string[] }[];
  MissingExternal?: string[];
  RefIssues?: { Project: string; Type: string; Asm: string; Other: string; Tfm: string; RefTfm: string }[];
}

type ProjStatus = "pending" | "building" | "ok" | "failed";

function toFileNoExt(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop()?.replace(/\.csproj$/, "") ?? "";
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
}

function shortPull(msg: string): string {
  const lines = msg
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const filtered = lines.filter(
    (l) => !/Checking out files|remote:|From https|Current branch|^\.\.\./i.test(l),
  );
  const summary = filtered.find((l) => /files changed/i.test(l));
  const first = filtered[0] ?? "";
  const text =
    summary && !first.toLowerCase().includes("files changed")
      ? `${first} · ${summary}`
      : summary ?? first;
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function aggregateErrors(log: string): {
  project: string;
  errors: string[];
  depFailed: string[];
  toolchain: string[];
}[] {
  const lines = log.split(/\r?\n/);
  const list: { project: string; errors: string[]; depFailed: string[]; toolchain: string[] }[] = [];
  const diag = new Map<string, string[]>();
  let cur: { project: string; errors: string[]; depFailed: string[]; toolchain: string[] } | null = null;
  for (const line of lines) {
    const f = line.match(/FAILED\s*\([^)]*\):\s*(.+)/);
    if (f) {
      cur = { project: toFileNoExt(f[1]) || f[1].trim(), errors: [], depFailed: [], toolchain: [] };
      list.push(cur);
      continue;
    }
    if (/Building:\s*.+\.\.\./.test(line)) {
      cur = null;
      continue;
    }
    if (line.includes("@@NEZHA_DIAG@@")) {
      const raw = line.split("@@NEZHA_DIAG@@")[1]?.trim();
      try {
        const d = JSON.parse(raw);
        const p = toFileNoExt(d.project || "");
        const dep = (d.depFailed ?? []) as string[];
        if (cur && p === cur.project) cur.depFailed = dep;
        else diag.set(p, dep);
      } catch {
        /* 忽略 */
      }
      continue;
    }
    if (cur && !/warning/i.test(line) && /error/i.test(line)) {
      const t = line.trim();
      if (t && cur.errors.length < 20) cur.errors.push(t.slice(0, 320));
    } else if (cur && /MSB3275|MSB3243|MSB3245|MSB3021|MSB3554|CS2012/i.test(line)) {
      const t = line.trim();
      if (t && cur.toolchain.length < 10) cur.toolchain.push(t.slice(0, 320));
    }
  }
  for (const item of list) {
    if (item.depFailed.length === 0 && diag.has(item.project)) item.depFailed = diag.get(item.project)!;
    if (item.errors.length === 0 && item.toolchain.length === 0) {
      item.errors.push(
        item.depFailed.length > 0
          ? `(依赖失败：${item.depFailed.join(", ")})`
          : "(无显式 error，可能为依赖失败)",
      );
    }
  }
  return list;
}

function buildFixPrompt(
  errorList: { project: string; errors: string[]; depFailed: string[]; toolchain: string[] }[],
): string {
  const out = [
    "请修复以下 HIS .NET Framework 构建失败。定位并修复这些失败项目，尽量保持最小改动；改完可重新构建验证。",
    "",
    "【失败项目】",
  ];
  for (const e of errorList) {
    out.push(
      `- ${e.project}${e.depFailed.length > 0 ? ` [依赖失败: ${e.depFailed.join(", ")}]` : ""}`,
    );
    for (const err of e.errors.slice(0, 8)) out.push(`    ${err}`);
    for (const t of e.toolchain.slice(0, 4)) out.push(`    [工具链] ${t}`);
  }
  return out.join("\n");
}

/**
 * 生成与 build.rs::run_build 成功回调一致的回写脚本：
 * 以主仓库目录名 + `.gitmodules` 里每个子模块名为 key，记录各自 `git rev-parse HEAD`，
 * 写入 `<root>/.nezha/build-state.json`，供下次「增量」构建做 diff 基线。
 * 内容全为 ASCII，用 `Set-Content -Encoding ascii`（无 BOM）写出，serde_json 可直接解析。
 */
function buildBaselineCommand(root: string): string {
  return [
    "$root = '" + root + "'",
    "$last = [ordered]@{}",
    "$last[(Split-Path $root -Leaf)] = (git -C $root rev-parse HEAD)",
    "git -C $root config --file .gitmodules --get-regexp '^submodule\\..*\\.path$' | ForEach-Object {",
    "  $k, $v = $_ -split '\\s+',2",
    "  if ($k -match '^submodule\\.(.+)\\.path$') {",
    "    $p = Join-Path $root $v",
    "    if (Test-Path $p) { $last[$Matches[1]] = (git -C $p rev-parse HEAD) }",
    "  }",
    "}",
    "@{ last_built = $last; updated_at = (Get-Date -Format o) } | ConvertTo-Json -Depth 5 |",
    "  Set-Content -Encoding ascii (Join-Path $root '.nezha\\build-state.json')",
  ].join("\n");
}

function computeFailedClosure(seed: string[], plan: Plan | null): string[] {
  const nameDeps = new Map<string, string[]>();
  for (const p of plan?.Projects ?? []) nameDeps.set(p.Name, p.Dependents ?? []);
  const include = [...seed];
  const seen = new Set(seed);
  const q = [...seed];
  while (q.length) {
    const n = q.pop()!;
    for (const d of nameDeps.get(n) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        include.push(d);
        q.push(d);
      }
    }
  }
  return include;
}

function statusColor(status: ProjStatus): string {
  if (status === "ok") return "var(--success, #30a46c)";
  if (status === "failed") return "var(--danger, #e5484d)";
  if (status === "building") return "var(--accent, #4f8cff)";
  return "var(--text-muted)";
}

export function BuildPanel({
  projectPath,
  width,
  onCreateFixTask,
  worktreePath,
}: {
  projectPath: string;
  width: number;
  worktreePath?: string;
  onCreateFixTask?: (t: {
    prompt: string;
    agent: string;
    permissionMode: string;
    launchMode: "local" | "worktree";
    baseBranch: string;
    repoPath: string;
  }) => void;
}) {
  const [repos, setRepos] = useState<BuildRepo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [config, setConfig] = useState<BuildConfig | null>(null);
  const [state, setState] = useState<BuildState>({ last_built: {} });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pullResults, setPullResults] = useState<PullResult[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [mode, setMode] = useState<"full" | "incremental" | "failed">("full");
  const [view, setView] = useState<"panel" | "fullscreen" | "collapsed">("panel");
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState("");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [projStatus, setProjStatus] = useState<Record<string, ProjStatus>>({});
  const [dllProgress, setDllProgress] = useState<{ done: number; total: number }>({
    done: 0,
    total: 0,
  });
  const [errorList, setErrorList] = useState<
    { project: string; errors: string[]; depFailed: string[]; toolchain: string[] }[]
  >([]);
  const [exportMsg, setExportMsg] = useState("");
  const [buildElapsed, setBuildElapsed] = useState(0);
  const [fixedProjects, setFixedProjects] = useState<string[]>([]);
  const [agentInfo, setAgentInfo] = useState<{ agent: string; perm: string } | null>(null);

  const logRef = useRef("");
  const logDirtyRef = useRef(false);
  const projStatusRef = useRef<Record<string, ProjStatus>>({});
  const projDirtyRef = useRef(false);
  const buildStartRef = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const load = useCallback(async () => {
    setError("");
    // 逐项容错加载：单个失败不拖垮整面板
    try {
      const repoList = await invoke<BuildRepo[]>("discover_build_repos", { projectPath });
      // 只显示 HIS + DrugInOut + Term（其余子模块后续再考虑）
      const visible = repoList.filter(
        (r) => !r.is_submodule || /druginou|term/i.test(r.name) || /druginou|term/i.test(r.path),
      );
      setRepos(visible);
      setSelected((prev) => {
        const next = new Set<string>();
        visible.forEach((r) => next.add(r.name));
        return next.size > 0 ? next : prev;
      });
    } catch (e) {
      setError(`仓库发现失败: ${String(e)}`);
    }
    try {
      setConfig(await invoke<BuildConfig>("read_build_config", { projectPath }));
    } catch (e) {
      setError(`配置读取失败: ${String(e)}`);
    }
    try {
      setState(await invoke<BuildState>("read_build_state", { projectPath }));
    } catch {
      /* 状态可缺省 */
    }
    try {
      const cfg = await invoke<{ agent: { default: string; default_permission_mode: string } }>(
        "read_project_config",
        { projectPath },
      );
      setAgentInfo({
        agent: cfg.agent.default,
        perm: cfg.agent.default_permission_mode || "ask",
      });
    } catch {
      /* 缺省用 claude/ask */
    }
    try {
      setFixedProjects(await invoke<string[]>("read_build_fix_status", { projectPath }));
    } catch {
      /* 状态可缺省 */
    }
    try {
      setPlan(await invoke<Plan | null>("read_build_plan", { projectPath }));
    } catch {
      setPlan(null);
    }
    // 面板关闭后重新打开时，恢复仍在运行中的构建句柄（可继续取消）
    try {
      const running = await invoke<string[]>("get_running_builds");
      if (running.length === 1) setRunningId(running[0]);
    } catch {
      /* 忽略 */
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // 低频 flush：raw log 与进度节流到 state，避免高频 setState
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (logDirtyRef.current) {
        setLogText(logRef.current);
        logDirtyRef.current = false;
      }
      if (projDirtyRef.current) {
        setProjStatus({ ...projStatusRef.current });
        projDirtyRef.current = false;
      }
    }, 150);
    return () => window.clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!runningId) return;
    const iv = window.setInterval(() => {
      void invoke<{ done: number; total: number }>("read_build_output_progress", {
        projectPath,
        sinceMs: buildStartRef.current,
      })
        .then((p) => setDllProgress(p))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(iv);
  }, [runningId, projectPath]);

  useEffect(() => {
    if (!runningId) return;
    const iv = window.setInterval(() => setBuildElapsed((v) => v + 1), 1000);
    return () => window.clearInterval(iv);
  }, [runningId]);

  const handlePull = useCallback(async () => {
    setError("");
    setPullResults([]);
    setStatusText("拉取中…");
    try {
      const res = await invoke<PullResult[]>("build_pull_repos", {
        projectPath,
        selected: Array.from(selectedRef.current),
      });
      setPullResults(res);
      const bad = res.filter((r) => !r.ok);
      setStatusText(bad.length === 0 ? "拉取完成" : `拉取有 ${bad.length} 个仓库被阻断`);
    } catch (e) {
      setError(String(e));
      setStatusText("");
    }
  }, [projectPath]);

  const handleBranch = useCallback(
    async (repo: BuildRepo, branch: string) => {
      setError("");
      setStatusText(`切换 ${repo.name} → ${branch}…`);
      try {
        await invoke("build_checkout_branch", { projectPath, repoPath: repo.path, branch });
        // 只原地更新被切换的仓库，不重跑全量仓库发现：
        // discover_build_repos 会把所有仓库的所有分支重新加载一遍，且未走 load 的 visible 过滤，
        // 会让隐藏的子模块（如 DrugInOut/Term 之外的那些）也跟着重新冒出来。
        setRepos((prev) =>
          prev.map((r) => (r.path === repo.path ? { ...r, branch } : r)),
        );
        setStatusText(`已切换到 ${repo.name}@${branch}`);
      } catch (e) {
        setError(String(e));
        setStatusText("");
      }
    },
    [projectPath],
  );

  const handleAnalyze = useCallback(async () => {
    setError("");
    setStatusText("分析中…");
    try {
      await invoke("analyze_build", { projectPath, options: { selected: Array.from(selectedRef.current) } });
      await load();
      setStatusText("计划已生成");
    } catch (e) {
      setError(String(e));
      setStatusText("");
    }
  }, [projectPath, load]);

  const handleRefreshBaseline = useCallback(async () => {
    setError("");
    setStatusText("刷新构建基线…");
    try {
      const st = await invoke<BuildState>("refresh_build_state", { projectPath });
      setState(st);
      setStatusText(`已刷新构建基线（${Object.keys(st.last_built).length} 个仓库）`);
    } catch (e) {
      setError(String(e));
      setStatusText("");
    }
  }, [projectPath]);

  const markProject = useCallback((pathOrName: string, status: ProjStatus) => {
    const key = toFileNoExt(pathOrName);
    if (!key) return;
    projStatusRef.current[key] = status;
    projDirtyRef.current = true;
  }, []);

  const handleCreateFixTask = useCallback(async () => {
    if (errorList.length === 0) return;
    // 从错误日志里取第一个 .csproj 绝对路径，定位它所属的仓库（取最长前缀匹配）
    const m = logRef.current.match(/[A-Za-z]:\\[^\s:]+\.csproj/);
    let repo: BuildRepo | undefined;
    if (m) {
      const path = m[0].replace(/\\/g, "/").toLowerCase();
      repo = repos.find((r) => path.startsWith(r.path.replace(/\\/g, "/").toLowerCase()));
    }
    const agent = agentInfo?.agent ?? "claude";
    // 修复任务默认 YOLO（full_access），agent 无需审批直接改。
    const perm = "full_access";
    const statusPath = `${projectPath.replace(/\\/g, "/")}/.nezha/build-fix-status.json`;
    const logPath = `${projectPath.replace(/\\/g, "/")}/Log/build-errors.txt`;

    // 先把错误信息写到日志文件，让 agent 读取，避免把整段塞进 prompt（上下文爆炸）
    const errText =
      "HIS 构建错误信息\n" +
      `失败项目数: ${errorList.length}\n\n` +
      buildFixPrompt(errorList);
    try {
      await invoke("export_build_errors", { projectPath, content: errText });
    } catch {
      /* 写失败不阻塞，prompt 里仍会引用该路径 */
    }

    const failNames = errorList.map((e) => e.project).join(", ");
    const fixPrompt =
      "请修复以下 HIS .NET Framework 构建失败：\n\n" +
      "第一步：用只读工具读取 " +
      logPath +
      "（已生成的错误日志文件），先总结出主要错误类别与失败项目；\n" +
      "第二步：按优先级逐个修复（尽量最小改动，必要时重新构建验证）；每修复好一个项目，把该项目名写入 " +
      statusPath +
      " 的 fixed 数组（JSON，保留其它项）作为“已完成”标记。\n\n" +
      "第三步：所有失败项目都已修复且重新构建验证通过（进程退出码为 0）后，在 PowerShell 里执行下面这段命令，" +
      "把当前各仓库 commit 回写到项目增量基线 " +
      projectPath.replace(/\\/g, "/") +
      "/.nezha/build-state.json。否则下次「增量」构建仍会提示「无基于上次构建基准确认的变更」。\n" +
      "```powershell\n" +
      buildBaselineCommand(projectPath) +
      "\n```\n" +
      "若当前 shell 不是 PowerShell，先进入 PowerShell 再执行；执行完请确认 .nezha/build-state.json 已生成且含 last_built 字段，才算收尾。\n\n" +
      "【失败项目（详细错误见日志文件）】\n" +
      (failNames || "(见日志文件)");
    const params = {
      prompt: fixPrompt,
      agent,
      permissionMode: perm,
      // 暂用 local（直接在项目根跑，agent 看到所有子仓库），避开子模块 worktree 卡死；
      // 子模块 worktree 隔离后续单独修。
      launchMode: "local" as "local" | "worktree",
      baseBranch: repo?.branch ?? "",
      repoPath: projectPath,
    };
    if (onCreateFixTask) {
      onCreateFixTask(params);
      setStatusText(`已发起修复任务（${repo?.name ?? projectPath}@${repo?.branch ?? ""}）`);
    } else {
      setStatusText("任务创建入口未接入");
    }
  }, [errorList, repos, agentInfo, projectPath, onCreateFixTask]);

  const appendLog = useCallback(
    (chunk: string) => {
      logRef.current += chunk;
      logDirtyRef.current = true;
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        const done = line.match(/@@NEZHA_BUILD_DONE@@\s*exit=(-?\d+)/);
        if (done) {
          const code = done[1];
          setRunningId(null);
          // 失败时保持当前视图（全屏专注不自动退出），成功才回到侧栏
          if (code === "0") setView("panel");
          setStatusText(code === "0" ? "构建完成" : `构建结束 exit=${code}`);
          // 每次构建结束都重算错误列表：成功则清空，失败则列出当前失败项目
          setErrorList(aggregateErrors(logRef.current));
          setMode(code === "0" ? "full" : "failed");
          continue;
        }
        let m = line.match(/Building:\s*(.+?)\s*\.\.\./);
        if (m) {
          markProject(m[1], "building");
          continue;
        }
        m = line.match(/ok\s*\([^)]*\):\s*(.+)/);
        if (m) {
          markProject(m[1], "ok");
          continue;
        }
        m = line.match(/FAILED\s*\([^)]*\):\s*(.+)/);
        if (m) {
          markProject(m[1], "failed");
        }
      }
    },
    [markProject],
  );

  const handleRun = useCallback(async () => {
    setError("");
    setLogText("");
    logRef.current = "";
    setProjStatus({});
    projStatusRef.current = {};
    if (plan?.Projects) {
      const init: Record<string, ProjStatus> = {};
      for (const p of plan.Projects) init[toFileNoExt(p.Path)] = "pending";
      projStatusRef.current = init;
      projDirtyRef.current = true;
    }

    let include: string[] = [];
    if (mode === "failed") {
      const unfinished = errorList
        .filter((e) => !fixedProjects.includes(e.project))
        .map((e) => e.project);
      const seed = unfinished.length > 0 ? unfinished : errorList.map((e) => e.project);
      include = computeFailedClosure(seed, plan);
      setStatusText(`仅编失败范围 ${include.length} 个项目（含依赖方）…`);
    } else if (mode !== "full") {
      try {
        setStatusText("计算增量范围…");
        include = await invoke<string[]>("compute_incremental_include", {
          projectPath,
          selected: Array.from(selectedRef.current),
        });
      } catch (e) {
        setError(String(e));
        setStatusText("");
        return;
      }
    }

    const channel = new Channel<string>();
    channel.onmessage = (data) => appendLog(data);
    const options = {
      selected: Array.from(selectedRef.current),
      include,
      continue_on_error: true,
      skip_external_check: config?.skip_external_check ?? false,
      skip_restore: config?.skip_restore ?? false,
      skip_clean: config?.skip_clean ?? false,
      external_dll_dir: worktreePath ? `${worktreePath}\\_run` : config?.external_dll_dir ?? "",
    };
    try {
      const id = await invoke<string>("run_build", { projectPath, options, onOutput: channel });
      setRunningId(id);
      buildStartRef.current = Date.now();
      setDllProgress({ done: 0, total: 0 });
      setBuildElapsed(0);
      void load();
      setStatusText("构建运行中…");
    } catch (e) {
      setError(String(e));
      setStatusText("");
    }
  }, [projectPath, plan, mode, config, appendLog, load, errorList, fixedProjects, worktreePath]);

  const handleCancel = useCallback(async () => {
    if (!runningId) return;
    try {
      await invoke("cancel_build", { buildId: runningId });
      setRunningId(null);
      setView("panel");
      setStatusText("已取消");
    } catch (e) {
      setError(String(e));
    }
  }, [runningId]);

  const toggleFixed = useCallback(
    async (project: string) => {
      const next = fixedProjects.includes(project)
        ? fixedProjects.filter((p) => p !== project)
        : [...fixedProjects, project];
      setFixedProjects(next);
      try {
        await invoke("write_build_fix_status", { projectPath, fixed: next });
      } catch {
        /* 忽略 */
      }
    },
    [projectPath, fixedProjects],
  );

  const exportErrors = useCallback(async () => {
    setExportMsg("导出中…");
    const banner = repos
      .filter((r) => selected.has(r.name) && !r.missing)
      .map((r) => `${r.name}@${r.branch || "?"}`)
      .join(" · ");
    const content = [
      "HIS 构建错误信息导出",
      `时间: ${new Date().toLocaleString()}`,
      `构建分支: ${banner || "—"}`,
      "",
      "【失败项目】",
      ...errorList.map(
        (e) =>
          `- ${e.project}\n${e.errors
            .slice(0, 8)
            .map((x) => `    ${x}`)
            .join("\n")}`,
      ),
    ].join("\n");
    try {
      const path = await invoke<string>("export_build_errors", { projectPath, content });
      setExportMsg(`已导出：${path}`);
    } catch (e) {
      setExportMsg(`导出失败：${String(e)}`);
    }
  }, [projectPath, errorList, repos, selected]);

  const handleConfigSave = useCallback(async () => {
    if (!config) return;
    try {
      await invoke("write_build_config", { projectPath, build: config });
      setStatusText("配置已保存");
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, config]);

  const projectList = useMemo(() => plan?.Projects ?? [], [plan]);
  const stageOrder = useMemo(() => plan?.StageOrder ?? [], [plan]);
  const groupedByStage = useMemo(() => {
    const g = new Map<string, PlanProject[]>();
    for (const p of projectList) {
      const label = p.StageLabel;
      const arr = g.get(label) ?? [];
      arr.push(p);
      g.set(label, arr);
    }
    return g;
  }, [projectList]);

  const missingExternal = plan?.MissingExternal ?? [];
  const conflicts = plan?.ExternalConflicts ?? [];
  const totalRefs = plan?.ExternalRefs?.length ?? 0;
  const branchBanner = repos
    .filter((r) => selected.has(r.name) && !r.missing)
    .map((r) => `${r.name}@${r.branch || "?"}`)
    .join("  ·  ");

  const failedProjects = projectList.filter(
    (p) => projStatus[toFileNoExt(p.Path)] === "failed",
  );
  const okCount = projectList.filter((p) => projStatus[toFileNoExt(p.Path)] === "ok").length;
  const totalProjects = projectList.length;
  const completedCount = projectList.filter((p) => {
    const st = projStatus[toFileNoExt(p.Path)];
    return st === "ok" || st === "failed";
  }).length;
  // 因 temp-out + 合并回共享目录，每个项目都会重写 dll（mtime 更新），dll 计数可靠；
  // 计划未就绪时回退到项目完成数。
  const progTotal = dllProgress.total > 0 ? dllProgress.total : totalProjects;
  const progDone = dllProgress.total > 0 ? dllProgress.done : completedCount;
  const progressPct = progTotal > 0 ? Math.round((progDone / progTotal) * 100) : 0;
  const buildingProj = projectList.find((p) => projStatus[toFileNoExt(p.Path)] === "building");
  const currentStageLabel = buildingProj?.StageLabel ?? "";

  const errorCard = (
    <div style={s.card}>
      <div style={s.cardTitle}>错误信息列表</div>
      {errorList.length === 0 ? (
        <div style={s.meta}>构建失败后在此列出失败项目及报错。</div>
      ) : (
        <div>
          {errorList.slice(0, 40).map((e) => (
            <div
              key={e.project}
              style={{ padding: "4px 0", borderBottom: "1px solid var(--border-dim, #262626)" }}
            >
              <div style={s.repoRow}>
                <input
                  type="checkbox"
                  checked={fixedProjects.includes(e.project)}
                  onChange={() => void toggleFixed(e.project)}
                />
                <span
                  style={{
                    color: fixedProjects.includes(e.project)
                      ? "var(--success, #30a46c)"
                      : "var(--danger, #e5484d)",
                  }}
                >
                  {e.project}
                </span>
              </div>
              {e.depFailed.length > 0 && (
                <div style={{ ...s.failedItemInfo, paddingLeft: 22, color: "var(--warning, #f5a623)" }}>
                  依赖失败: {e.depFailed.join(", ")}
                </div>
              )}
              {e.errors.slice(0, 6).map((err, i) => (
                <div key={i} style={{ ...s.failedItemInfo, paddingLeft: 22 }}>
                  {err}
                </div>
              ))}
              {e.toolchain.slice(0, 4).map((t, i) => (
                <div key={`tc${i}`} style={{ ...s.failedItemInfo, paddingLeft: 22, color: "var(--text-muted)" }}>
                  [工具链] {t}
                </div>
              ))}
            </div>
          ))}
          {errorList.length > 40 && <div style={s.meta}>… 共 {errorList.length} 个失败项目</div>}
        </div>
      )}
      {errorList.length > 0 && (
        <div style={{ ...s.buttonRow, marginTop: 8 }}>
          <button
            style={{ ...s.buttonSmall, ...s.buttonPrimary }}
            onClick={() => handleCreateFixTask()}
          >
            发起修复任务
          </button>
          <button style={s.buttonSmall} onClick={() => void exportErrors()}>
            导出错误信息
          </button>
        </div>
      )}
      {exportMsg && <div style={{ ...s.meta, marginTop: 6 }}>{exportMsg}</div>}
    </div>
  );

  const monitorBody = (
    <div style={s.fsBody}>
      <div style={s.fsLeft}>
        {failedProjects.length > 0 && (
          <div style={{ ...s.card, marginBottom: 10 }}>
            <div style={s.cardTitle}>失败项目（连锁影响）</div>
            {failedProjects.map((p) => (
              <div key={p.Path} style={s.failedItem}>
                <span>{p.Name}</span>
                {(p.Dependents?.length ?? 0) > 0 && (
                  <span style={s.failedItemInfo}>依赖它的 {p.Dependents!.length} 个需关注</span>
                )}
              </div>
            ))}
          </div>
        )}
          {errorCard}
        <div style={s.card}>
          <div style={s.cardTitle}>阶段流水线</div>
          {stageOrder.map((st) => {
            const projects = groupedByStage.get(st.Label) ?? [];
            const done = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "ok").length;
            const fail = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "failed").length;
            const building = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "building").length;
            return (
              <div key={st.Name} style={s.stageGroup}>
                <div style={s.stageHead}>
                  <span>{st.Label}</span>
                  <span style={s.meta}>
                    {done}/{st.Count}
                    {building ? ` · 构建中 ${building}` : ""}
                    {fail ? ` · 失败 ${fail}` : ""}
                  </span>
                </div>
                {projects.slice(0, 10).map((p) => {
                  const status = projStatus[toFileNoExt(p.Path)] ?? "pending";
                  return (
                    <div key={p.Path} style={s.projRow}>
                      <span style={{ ...s.projDot, background: statusColor(status) }} />
                      <span>{p.Name}</span>
                    </div>
                  );
                })}
                {projects.length > 10 && <div style={s.meta}>… 共 {projects.length} 个项目</div>}
              </div>
            );
          })}
        </div>
      </div>
      <div style={s.fsRight}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "8px 12px",
            borderBottom: "1px solid var(--border-dim, #262626)",
          }}
        >
          <span style={s.meta}>原始输出</span>
          <button style={s.buttonSmall} onClick={() => setLogText("")}>
            清空
          </button>
        </div>
        <div style={s.fsLog}>{logText || "(等待输出…)"}</div>
      </div>
    </div>
  );

  const fullscreenRoot = createPortal(
    <div style={s.fsRoot}>
      <div style={s.fsHeader}>
        <div style={s.fsTitle}>
          <Hammer size={16} />
          <span>构建</span>
        </div>
        <div style={s.fsBanner}>
          <span style={s.meta}>分支</span>
          <span>{branchBanner || "—"}</span>
        </div>
        <div style={s.meta}>
          ok {okCount}/{totalProjects}
          {failedProjects.length > 0 ? ` · 失败 ${failedProjects.length}` : ""}
          {runningId ? " · 运行中" : ""}
        </div>
        <div style={s.fsActions}>
          <button style={s.buttonSmall} onClick={() => setView("collapsed")}>
            收起
          </button>
          {runningId && (
            <button style={{ ...s.buttonSmall, ...s.buttonDanger }} onClick={handleCancel}>
              取消
            </button>
          )}
          <button style={s.buttonSmall} onClick={() => setView("panel")}>
            退出构建视图
          </button>
        </div>
      </div>
      <div style={{ padding: "8px 16px 0" }}>
        <div style={s.progressText}>
          进度 {progDone}/{progTotal} · {progressPct}% · {currentStageLabel || "—"} · 用时{" "}
          {fmtDur(buildElapsed)}
        </div>
        <div style={s.progressTrack}>
          <div style={{ ...s.progressFill, width: `${progressPct}%` }} />
        </div>
      </div>
      {monitorBody}
    </div>,
    document.body,
  );

  const collapsedBar = createPortal(
    <div style={s.collapseBar}>
      <Hammer size={13} />
      <span>构建中：{branchBanner || "—"}</span>
      <span style={s.collapseBarSpacer} />
      <span style={s.meta}>
        ok {okCount}/{totalProjects}
        {failedProjects.length > 0 ? ` · 失败 ${failedProjects.length}` : ""}
      </span>
      <button style={s.buttonSmall} onClick={() => setView("fullscreen")}>
        展开
      </button>
      <button style={{ ...s.buttonSmall, ...s.buttonDanger }} onClick={handleCancel}>
        取消
      </button>
    </div>,
    document.body,
  );

  const sidePanel = (
    <div style={{ ...s.panelRoot, width }}>
      <div style={s.header}>
        <div style={s.headerTitle}>
          <Hammer size={15} />
          <span>构建</span>
        </div>
        <button style={s.buttonSmall} onClick={() => setView("fullscreen")}>
          全屏
        </button>
      </div>

      <div style={s.scroll}>
        {/* 仓库 */}
        <div style={s.card}>
          <div style={s.cardTitle}>仓库拉取</div>
          {repos.length === 0 && <div style={s.meta}>未发现 git 仓库</div>}
          {repos.map((r) => (
            <div key={r.name} style={s.repoRow}>
              <input
                type="checkbox"
                checked={selected.has(r.name)}
                onChange={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.name)) next.delete(r.name);
                    else next.add(r.name);
                    return next;
                  })
                }
              />
              <span style={s.repoName} title={r.path}>
                {r.name}
              </span>
              <BranchSelect repo={r} onChange={(b) => void handleBranch(r, b)} />
              {r.missing ? (
                <span style={{ ...s.badge, color: "var(--danger, #e5484d)" }}>缺失</span>
              ) : r.dirty ? (
                <span style={{ ...s.badge, color: "var(--warning, #f5a623)" }}>脏</span>
              ) : null}
            </div>
          ))}
          <div style={{ ...s.buttonRow, marginTop: 8 }}>
            <button style={s.button} onClick={handlePull}>
              拉取
            </button>
            <button style={s.button} onClick={() => void handleAnalyze()}>
              分析/计划
            </button>
            <button style={s.button} onClick={() => void load()}>
              <RefreshCw size={12} />
              刷新
            </button>
            <button style={s.button} onClick={() => void handleRefreshBaseline()}>
              <RefreshCw size={12} />
              刷新基线
            </button>
          </div>
        </div>

        {pullResults.length > 0 && (
          <div style={s.card}>
            {pullResults.map((r) => (
              <div
                key={r.name}
                style={{
                  ...s.statusLine,
                  fontSize: 11,
                  color: r.ok ? undefined : "var(--danger, #e5484d)",
                }}
              >
                {r.ok ? "✓" : "×"} {r.name}: {shortPull(r.message)}
              </div>
            ))}
          </div>
        )}

        {/* 构建分支横幅 */}
        {branchBanner && (
          <div style={s.banner}>
            <span style={s.meta}>构建分支</span>
            <span>{branchBanner}</span>
          </div>
        )}

        {/* 构建 */}
        <div style={s.card}>
          <div style={s.cardTitle}>构建</div>
          <div style={s.segRow}>
            {(["full", "incremental", "failed"] as const).map((m) => (
              <button
                key={m}
                style={{ ...s.segBtn, ...(mode === m ? s.segActive : null) }}
                onClick={() => setMode(m)}
              >
                {m === "full" ? "全量" : m === "incremental" ? "增量" : "仅失败"}
              </button>
            ))}
          </div>
          <div style={{ ...s.buttonRow, marginTop: 8 }}>
            {runningId ? (
              <button style={{ ...s.button, ...s.buttonDanger }} onClick={handleCancel}>
                <X size={13} />
                取消
              </button>
            ) : (
              <button
                style={{ ...s.button, ...s.buttonPrimary }}
                onClick={handleRun}
              >
                <Play size={13} />
                运行构建
              </button>
            )}
          </div>
          {runningId && (
            <div>
              <div style={s.progressText}>
                进度 {progDone}/{progTotal} · {progressPct}%
                {currentStageLabel ? ` · ${currentStageLabel}` : ""}
                <span style={s.meta}> · 用时 {fmtDur(buildElapsed)}</span>
              </div>
              <div style={s.progressTrack}>
                <div style={{ ...s.progressFill, width: `${progressPct}%` }} />
              </div>
            </div>
          )}
        </div>

        {statusText && <div style={s.statusLine}>{statusText}</div>}
        {error && <div style={{ ...s.statusLine, ...s.errText }}>{error}</div>}
        {state.updated_at && <div style={s.meta}>上次构建基线: {state.updated_at}</div>}
          {errorCard}

        {plan?.Scope && (
          <div style={s.meta}>
            范围：{plan.Scope.TotalProjects} 项目 / 排除 {plan.Scope.CoreExcluded} / 编译{" "}
            {plan.Scope.ToBuild}
          </div>
        )}

        {/* 环境检查 */}
        {plan && (
          <div style={s.card}>
            <div style={s.cardTitle}>环境检查</div>
            <div style={s.meta}>外部依赖 dll 引用 {totalRefs} 处</div>
            {missingExternal.length > 0 ? (
              <div style={{ ...s.statusLine, ...s.errText }}>
                缺失 {missingExternal.length} 个：{missingExternal.slice(0, 6).join(", ")}
                {missingExternal.length > 6 ? " …" : ""}
              </div>
            ) : (
              <div style={{ ...s.statusLine, ...s.okText }}>外部依赖齐全</div>
            )}
            {conflicts.length > 0 && (
              <div style={{ ...s.statusLine, ...s.warnText }}>
                版本冲突 {conflicts.length} 个：{conflicts.slice(0, 3).map((c) => c.Dll).join(", ")}
              </div>
            )}
            {(plan.RefIssues?.length ?? 0) > 0 && (
              <div style={{ ...s.statusLine, ...s.warnText }}>
                引用健康 {plan.RefIssues!.length} 处：{" "}
                {plan.RefIssues!.slice(0, 5)
                  .map((r) => `${r.Project}(${r.Type})`)
                  .join(", ")}
              </div>
            )}
          </div>
        )}

        {/* 阶段流水线 */}
        {stageOrder.length > 0 && (
          <div style={s.card}>
            <div style={s.cardTitle}>阶段流水线</div>
            {stageOrder.map((st) => {
              const projects = groupedByStage.get(st.Label) ?? [];
              const done = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "ok").length;
              const fail = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "failed").length;
              const building = projects.filter((p) => projStatus[toFileNoExt(p.Path)] === "building").length;
              return (
                <div key={st.Name} style={s.stageGroup}>
                  <div style={s.stageHead}>
                    <span>{st.Label}</span>
                    <span style={s.meta}>
                      {done}/{st.Count}
                      {building ? ` · 构建中 ${building}` : ""}
                      {fail ? ` · 失败 ${fail}` : ""}
                    </span>
                  </div>
                  {projects.slice(0, 10).map((p) => {
                    const status = projStatus[toFileNoExt(p.Path)] ?? "pending";
                    return (
                      <div key={p.Path} style={s.projRow}>
                        <span style={{ ...s.projDot, background: statusColor(status) }} />
                        <span>{p.Name}</span>
                      </div>
                    );
                  })}
                  {projects.length > 10 && <div style={s.meta}>… 共 {projects.length} 个项目</div>}
                </div>
              );
            })}
          </div>
        )}

        {/* 原始输出 */}
        <div>
          <button style={s.button} onClick={() => setLogOpen((v) => !v)}>
            {logOpen ? "收起原始输出" : "展开原始输出"}
          </button>
          {logOpen && (
            <div style={{ ...s.logBox, marginTop: 8 }}>
              <div style={s.logScroll}>{logText || "(等待输出…)"}</div>
            </div>
          )}
        </div>

        {/* 配置 */}
        <div style={s.card}>
          <div style={s.cardTitle}>构建配置</div>
          {config ? (
            <div>
              <div style={s.configField}>
                <label style={s.configLabel}>脚本路径（留空自动探测）</label>
                <input
                  style={s.configInput}
                  value={config.script_path}
                  onChange={(e) => setConfig({ ...config, script_path: e.target.value })}
                />
              </div>
              <div style={s.configField}>
                <label style={s.configLabel}>MSBuild 路径（留空自动探测）</label>
                <input
                  style={s.configInput}
                  value={config.msbuild_path}
                  onChange={(e) => setConfig({ ...config, msbuild_path: e.target.value })}
                />
              </div>
              <div style={s.configField}>
                <label style={s.configLabel}>并行度 MaxParallel（1=串行，2-8 并行）</label>
                <input
                  style={s.configInput}
                  type="number"
                  min={1}
                  max={8}
                  value={config.max_parallel || 1}
                  onChange={(e) => setConfig({ ...config, max_parallel: Number(e.target.value) })}
                />
              </div>
              <div style={s.buttonRow}>
                <button style={s.button} onClick={handleConfigSave}>
                  保存配置
                </button>
              </div>
            </div>
          ) : (
            <div style={s.meta}>未读取到配置</div>
          )}
        </div>
      </div>
    </div>
  );

  if (view === "fullscreen") return fullscreenRoot;
  if (view === "collapsed") return (
    <>
      {sidePanel}
      {collapsedBar}
    </>
  );
  return sidePanel;
}

function BranchSelect({
  repo,
  onChange,
}: {
  repo: BuildRepo;
  onChange: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const openMenu = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      // 右侧面板内，菜单右对齐到按钮，向左展开避免裁切
      setPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 200) });
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const disabled = repo.missing || repo.branches.length === 0;

  return (
    <>
      <button
        ref={btnRef}
        style={s.branchTrigger}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          if (open) setOpen(false);
          else openMenu();
        }}
      >
        <GitBranch size={11} />
        <span>{repo.branch || "选择分支"}</span>
        <ChevronDown size={12} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: pos.top,
              left: pos.left,
              zIndex: 2147483000,
              minWidth: 200,
              maxHeight: 260,
              overflowY: "auto",
              background: "var(--bg-card)",
              border: "1px solid var(--border-dim, #2a2a2a)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,.4)",
              padding: 4,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {repo.branches.map((b) => (
              <div
                key={b}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 12,
                  color: b === repo.branch ? "var(--accent, #4f8cff)" : "var(--text-primary)",
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "var(--bg-hover)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                }}
                onClick={() => {
                  onChange(b);
                  setOpen(false);
                }}
              >
                <span>{b}</span>
                {b === repo.branch && <Check size={13} />}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
