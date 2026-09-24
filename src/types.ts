export interface Project {
  id: string;
  name: string;
  path: string;
  branch?: string;
  lastOpenedAt: number;
  /** 为 true 时不在左侧常驻竖条显示，仅可从首页或「展开全部」抽屉访问。缺省=常驻。 */
  hiddenFromRail?: boolean;
}

/** 单个 git 工作目录。
 * - 单仓库项目：根目录自身即 git，roots = [{ path: project.path, name: ".", isRoot: true }]
 * - 多仓库工作区（如根目录非 git，但下面有多个子 git 目录）：roots = 每个子目录一项
 * - 完全不是 git：roots = []
 */
export interface GitRoot {
  path: string;
  name: string;
  isRoot: boolean;
}

export type AgentType = "claude" | "codex" | "dsh";
export type ThemeMode = "system" | "dark" | "light" | "eyecare" | "midnight";
export type ThemeVariant = "dark" | "light" | "eyecare" | "midnight";
export type PermissionMode = "ask" | "auto_edit" | "full_access";
export type TaskDisplayWindow = 3 | 7 | 15 | 30 | "all";

export const TASK_DISPLAY_WINDOW_VALUES = [3, 7, 15, 30, "all"] as const;
export const DEFAULT_TASK_DISPLAY_WINDOW: TaskDisplayWindow = 3;

export function normalizeTaskDisplayWindow(value: unknown): TaskDisplayWindow {
  if (value === "all") return "all";
  const parsed = typeof value === "number" ? value : Number(value);
  return TASK_DISPLAY_WINDOW_VALUES.includes(parsed as TaskDisplayWindow)
    ? (parsed as TaskDisplayWindow)
    : DEFAULT_TASK_DISPLAY_WINDOW;
}

export type TerminalFontSize = number;

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const TERMINAL_FONT_SIZE_STEP = 1;
export const DEFAULT_TERMINAL_FONT_SIZE: TerminalFontSize = 12;

export function clampTerminalFontSize(value: number): TerminalFontSize {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
  const snapped = Math.round(value / TERMINAL_FONT_SIZE_STEP) * TERMINAL_FONT_SIZE_STEP;
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, snapped));
}

export type TerminalScrollback = number;

export const TERMINAL_SCROLLBACK_MIN = 500;
export const TERMINAL_SCROLLBACK_MAX = 5000;
export const TERMINAL_SCROLLBACK_STEP = 500;
export const DEFAULT_TERMINAL_SCROLLBACK: TerminalScrollback = 1000;

export function clampTerminalScrollback(value: unknown): TerminalScrollback {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_TERMINAL_SCROLLBACK;
  const snapped =
    Math.round(num / TERMINAL_SCROLLBACK_STEP) * TERMINAL_SCROLLBACK_STEP;
  return Math.min(TERMINAL_SCROLLBACK_MAX, Math.max(TERMINAL_SCROLLBACK_MIN, snapped));
}

export type FontFamily = string;
export const DEFAULT_UI_FONT: FontFamily =
  '"SF Pro Display", "IBM Plex Sans", "PingFang SC", "Noto Sans SC", sans-serif';

const MONO_FONT_WINDOWS: FontFamily = "Consolas";
const MONO_FONT_WINDOWS_STACK: FontFamily =
  'Consolas, "Cascadia Mono", "JetBrains Mono", "Fira Code", monospace';
const MONO_FONT_MAC: FontFamily =
  '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, ui-monospace, monospace';
const MONO_FONT_LINUX: FontFamily =
  '"JetBrains Mono", "Fira Code", "DejaVu Sans Mono", "Liberation Mono", ui-monospace, monospace';
const MONO_FONT_FALLBACK: FontFamily =
  '"JetBrains Mono", "Fira Code", ui-monospace, monospace';
const MONO_FONT_PR326_INITIAL_FALLBACK: FontFamily =
  '"JetBrains Mono", "Fira Code", "Cascadia Mono", Consolas, "SF Mono", Menlo, ui-monospace, monospace';

export function getDefaultMonoFont(): FontFamily {
  if (typeof navigator === "undefined") return MONO_FONT_FALLBACK;
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return MONO_FONT_WINDOWS;
  if (/Mac OS X|Macintosh/i.test(ua)) return MONO_FONT_MAC;
  if (/Linux/i.test(ua)) return MONO_FONT_LINUX;
  return MONO_FONT_FALLBACK;
}

// 老版本 App.tsx 的 useEffect 无差别把当时的默认 mono 字体也写进 localStorage,
// 导致后续改默认对老用户失效。所有"曾经作为自动默认值出现过"的字符串都视为
// "用户未自定义",在 getInitialFontFamily 里清掉后回退到当前平台默认。
const LEGACY_AUTO_MONO_FONTS: ReadonlySet<string> = new Set([
  MONO_FONT_FALLBACK,
  MONO_FONT_WINDOWS,
  MONO_FONT_WINDOWS_STACK,
  MONO_FONT_MAC,
  MONO_FONT_LINUX,
  MONO_FONT_PR326_INITIAL_FALLBACK,
]);

export function isAutoDefaultMonoFont(value: string): boolean {
  return LEGACY_AUTO_MONO_FONTS.has(value.trim());
}

export type TaskStatus =
  | "todo"
  | "pending"
  /** 方案待办的前置依赖未完成（或已满足但在并发队列排队）——不创建 PTY，非活跃态。 */
  | "waiting_deps"
  | "running"
  | "input_required"
  | "awaiting_review"
  | "detached"
  | "interrupted"
  | "done"
  | "failed"
  | "cancelled";

/** 分支批的分支类型：feature=日常开发（自 develop 拉），fix=缺陷修复，patch=现场响应，
 *  project=上线验收/项目分支，hotfix=补丁容器。 */
export type BranchKind = "feature" | "fix" | "patch" | "project" | "hotfix";

/** 交付计划（DeliveryPlan）= 一个可独立交付的单元：一组有序云效议题成员＋一条分支
 *  ＋可选一个 worktree＋至多一个 MR（由「分支批」升维而来）。
 *  默认只在主工作区切出计划分支；选择另建 worktree 才有独立代码目录。 */
export interface DeliveryPlan {
  id: string;
  projectId: string;
  name: string;
  kind: BranchKind;
  /** 计划的源分支名（如 fix/v2.20260901/develop/锁号地址挂号异常问题）。 */
  branch: string;
  /** 基础分支（如 develop / master 的 tag），分支由此切出。 */
  baseBranch: string;
  /** 合并回的目标分支（通常为 develop 或 master）；允许为空 = 暂不指定合并目标（不能提交 MR / 合并回）。 */
  targetBranch: string;
  /** 成员＝云效议题快照（有序＝任务顺序）。取代旧 taskIds / issueSerialNumbers。 */
  issues: PlanIssue[];
  /** active | review | merged | closed */
  status: DeliveryPlanStatus;
  createdAt: number;
  /** 计划关闭（closed/merged）时间戳。 */
  closedAt?: number;
  /** Codeup 合并请求 id（提交 MR 成功后回填；存 localId）。 */
  mrId?: string;
  /** Codeup 合并请求状态（提交后跟随 MR 状态回填，计划详情展示）。 */
  mrStatus?: MrStatus;
  /** 创建时实际落盘的 worktree 路径（优先于硬编码推导，兼容共享 hub / 自定义基路径）。 */
  worktreePath?: string;
  /** worktree 所属 sub-repo 路径（多仓库工作区）。 */
  worktreeRepo?: string;
  /** 该计划是否另建 worktree；false（默认）表示计划分支就在主工作区里。 */
  useWorktree?: boolean;
  /** 列表实时探测：未关闭计划的工作树下缺少运行程序目录（`_run`）时为 true，仅提示不落盘。 */
  runRootMissing?: boolean;
  /** 列表实时探测：未关闭计划的 worktree 目录缺失时为 true，仅提示不落盘。 */
  worktreeMissing?: boolean;
  /** 提交 MR 时源分支 HEAD SHA。 */
  mrSourceSha?: string;
}

/** 新建 PR 前的源分支冲突预检结果。 */
export interface BranchConflictCheck {
  remoteExists: boolean;
  localExists: boolean;
}

/** Codeup 合并请求生命周期状态。 */
export type MrStatus =
  | "opened"
  | "approved"
  | "merging"
  | "merged"
  | "rejected"
  | "closed";

/** 计划状态机（仅此 4 态有写者）：create→active、create_mr→review、merge→merged、delete/close→closed。 */
export type DeliveryPlanStatus = "active" | "review" | "merged" | "closed";

/** 跨项目聚合的 Codeup 合并请求（欢迎页合并审核用）。 */
export interface CodeupMr {
  projectId: string;
  projectPath: string;
  repository: string;
  id: string;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  status: string;
  author: string;
  reviewers: string[];
  createdAt: number;
  /** Codeup 仓库 id（数字，按仓库操作 MR 用）。 */
  repositoryId: string;
  /** 仓库内 MR 编号（change 的 local id）。 */
  localId: number;
  /** 是否存在冲突。 */
  hasConflict: boolean;
  /** MR 详情 web 链接。 */
  detailUrl: string;
  updatedAt: number;
  /** 本地是否已拉取该 MR 代码（用于「拉取代码」门禁）。 */
  pulled: boolean;
  /** 已拉取后的本地 worktree 路径。 */
  worktreePath: string;
}

/** 合并代码审查的逐项判定（`.nezha/review-<mrId>.json`，与后端 ReviewFinding 对应）。 */
export interface CodeupReviewFinding {
  rule: string;
  status: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  message: string;
}

/** Codeup 仓库（欢迎页合并审核的仓库过滤下拉用）。 */
export interface CodeupRepository {
  id: string;
  name: string;
  path: string;
  namespace: string;
  webUrl: string;
}

/** 目标分支推断来源（对齐后端 `TargetSource`）。 */
export type PendingTargetSource = "user" | "config" | "name" | "default";

/** 合并三态（对齐后端 `MergeState`）。 */
export type PendingMergeState = "unmerged" | "merged" | "partial";

/** 受保护判定来源（对齐后端 `ProtectedSource`）。 */
export type PendingProtectedSource = "platform" | "git";

/** 「待发起」视图的单个分支候选（对齐后端 `BranchCandidate`）。 */
export interface PendingBranchCandidate {
  branch: string;
  repo: string;
  repoPath: string;
  /** 是否有 upstream（即已推送）。 */
  pushed: boolean;
  /** 远端独有（ls-remote 枚举而来，本地无检出）。 */
  remoteOnly: boolean;
  protected: boolean;
  protectedSource: PendingProtectedSource | null;
  /** 相对目标分支的未合并提交数。 */
  unmerged: number;
  mergeState: PendingMergeState;
  /** 已合并时合进了哪条源分支。 */
  mergedInto: string | null;
  targetBranch: string;
  targetSource: PendingTargetSource;
  /** 独有提交的作者集合里包含本人 git email。 */
  mine: boolean;
  authors: string[];
  lastCommitAuthor: string;
  lastCommitAt: number;
  additions: number;
  deletions: number;
  openMrId: number | null;
  openMrState: string;
  openMrConflict: boolean;
  /** 是否允许删除远端分支。 */
  deletable: boolean;
  skipReason: string;
  /** 该行部分数据缺失（如合并状态判定失败）。 */
  dataMissing: boolean;
}

/** 项目下一个可扫描的 git 仓库（对齐后端 `BranchRepoRef`）。 */
export interface PendingBranchRepoRef {
  name: string;
  path: string;
}

/** 「待发起」视图单个仓库的扫描结果（对齐后端 `BranchRepoScan`）。 */
export interface PendingBranchRepoScan {
  name: string;
  path: string;
  ok: boolean;
  message: string;
  /** 平台侧分支列表可用（false 表示受保护判定回落 git 口径）。 */
  platformOk: boolean;
  /** 平台侧开放 MR 数据可用（false 表示「是否有开放 MR」未知）。 */
  mrOk: boolean;
  branches: PendingBranchCandidate[];
}

/** 删除远端分支的定位信息（对齐后端 `RemoteBranchTarget`）。 */
export interface PendingRemoteBranchTarget {
  repoPath: string;
  repo: string;
  branch: string;
  targetBranch: string;
}
/** 删除远端分支的单项回执（对齐后端 `RemoteBranchPruneItem`）。 */
export interface PendingRemoteBranchPruneItem {
  repo: string;
  repoPath: string;
  branch: string;
  targetBranch: string;
  deleted: boolean;
  deletable: boolean;
  reason: string;
}

/** 批量发起合并请求的单项输入（对齐后端 `MrCreateItem`）。 */
export interface PendingMrCreateItem {
  repoPath: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  title?: string;
  description?: string;
  reviewers: string[];
}

/** 批量发起合并请求的逐条回执（对齐后端 `MrCreateReceipt`）。 */
export interface PendingMrCreateReceipt {
  repo: string;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  /** 本次是否真的创建了 MR（幂等跳过 / 失败时为 false）。 */
  created: boolean;
  mrId: string | null;
  mrLocalId: number | null;
  reason: string;
}

export interface Task {
  id: string;
  projectId: string;
  name?: string;
  prompt: string;
  agent: AgentType;
  permissionMode: PermissionMode;
  /** 缺省时沿用 agent 自身默认模型。保存任务快照，避免设置目录变化影响 resume/fork。 */
  model?: string;
  /** 缺省时沿用 agent 自身默认思考深度。 */
  reasoningEffort?: string;
  status: TaskStatus;
  createdAt: number;
  /** 任务状态最近一次变更的时间戳；左侧任务列表按此字段排序与分组。缺省时回落到 createdAt。 */
  updatedAt?: number;
  attentionRequestedAt?: number;
  starred?: boolean;
  failureReason?: string;
  codexSessionId?: string;
  codexSessionPath?: string;
  dshSessionId?: string;
  dshSessionPath?: string;
  claudeSessionId?: string;
  claudeSessionPath?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseBranch?: string;
  /** 所属交付计划 id；非空即该任务强制落在计划分支/worktree 上（不可改）。
   *  读侧兼容遗留 batchId 键（存量 JSON），后端反序列化时已映射。 */
  deliveryPlanId?: string;
  /** 该任务所在分支的类型；缺省跟随批或视为 feature。 */
  branchKind?: BranchKind;
  /** worktree 所属的 sub-repo 路径（多仓库工作区中追踪 worktree 归属于哪个 git 根）。
   *  缺省视为与项目根相同，向后兼容旧 worktree。 */
  worktreeRepo?: string;
  /** worktree 已被合并或丢弃后置 true：保留分支/路径用于审计，但禁用 resume / 合并 / 丢弃 */
  worktreeDiscarded?: boolean;
  /** 任务完成时计算的相对 baseBranch merge-base 的累计新增行数（仅 worktree 任务） */
  additions?: number;
  /** 任务完成时计算的相对 baseBranch merge-base 的累计删除行数（仅 worktree 任务） */
  deletions?: number;
  /** 导入自云效 Projex 的工作项 id（去重键：同一议题只导入一次） */
  yunxiaoWorkitemId?: string;
  /** 导入自云效 Projex 的工作项编号，如 QHDK-29728 */
  yunxiaoSerialNumber?: string;
  /** 修改方案已回写云效评论的时间戳（幂等标记，非空即已回写） */
  yunxiaoWrittenBackAt?: number;
  /** 回写成功后云效返回的评论 ID（审计/追查用） */
  yunxiaoCommentId?: string;
  /** 知识沉淀创建的云效审核议题 ID 列表（幂等标记：非空即已沉淀） */
  /**
   * 历史幂等标记（云效知识沉淀议题 ID）。
   * 自动沉淀已改为「任务完成即处理、不建议题」，该字段不再用于幂等判定，
   * 仅保留以兼容既有 `tasks.json`（不删除，避免破坏用户数据）。
   */
  knowledgeIssueIds?: string[];
  /** 起源任务 ID：本任务由哪个任务的讨论/执行中发现的问题补录而来（来源追溯） */
  derivedFromTaskId?: string;
  /** 起源云效议题 ID：补充的议题来自哪个已有议题的讨论发现（来源追溯） */
  derivedFromWorkitemId?: string;
  /** 多议题联合方案 id：执行任务与临时讨论任务通过它关联 Plan */
  planId?: string;
  /** 用户对异常/缺失前置选择「忽略依赖，仍然开始」后置 true：本次等待不再被硬依赖拦下 */
  planDepsIgnored?: boolean;
  /** 本任务是「方案讨论」临时任务（定稿后退场，不参与执行、不建 worktree） */
  yunxiaoPlanDiscussion?: boolean;
  /**
   * 无人值守执行：方案执行任务勾选后，agent 一轮结束（`Stop` → `awaiting_review`）
   * 即自动走一次「标记完成」收尾（`complete_task`：杀进程 → 收拢草稿 → 跑沉淀），
   * 使下游任务的硬依赖自动满足、整链无人接续。默认关闭（`undefined`/`false`）。
   *
   * 代价：agent 中途反问也会被判完成；因此生成时权限被强制为 `full_access`
   * （`ask`/`auto_edit` 会停在 `input_required` 挂死）。见 `planQueue.resolvePlanTodoLaunch`。
   */
  unattended?: boolean;
}

/** 多议题联合方案（Plan）的议题快照：发起时从云效列表抄录，预览/确认页离线可用。 */
export interface PlanIssue {
  workitemId: string;
  serialNumber: string;
  subject: string;
  /** 云效类别（Req / Task / Bug）；未知为空 */
  category?: string;
}

/** 方案生命周期：讨论中 → 已定稿 → 执行中 → 已完成；cancelled = 已取消。 */
export type PlanStatus = "draft" | "finalized" | "executing" | "completed" | "cancelled";

/** 多议题联合方案：一份方案覆盖 N 个云效议题；正文与图片在项目内
 *  `.nezha/plans/<planId>/`（plan.md + images/），元数据持久化在 plans.json。 */
export interface Plan {
  id: string;
  projectId: string;
  name: string;
  /** 议题快照（有序 = 建议执行顺序） */
  issues: PlanIssue[];
  status: PlanStatus;
  /** 承载方案讨论的临时任务 id */
  discussionTaskId?: string;
  /** （休眠）历史字段，计划关联经 workitemId 派生 */
  batchId?: string;
  /** 主方案 id：本方案是它的追加子方案（一次追加的一批议题合成）。依赖不由它决定，见 deps.json */
  parentPlanId?: string;
  createdAt: number;
  finalizedAt?: number;
  /** 归档时间戳：非空即不占方案看板主列（展示层标记，与 status 正交，可反归档） */
  archivedAt?: number;
}

/** 知识自动回写单条结果。 */
export interface KnowledgeWritebackItem {
  index: number;
  module: string;
  section: string;
  passed: boolean;
  written: boolean;
  reason: string;
  /** 判定发生的层次：`L0` 结构 / `L1` 依据 / `L2` 去重 / `L3` 语义 / `write` 写入。 */
  layer: string;
}

/** 任务完成后自动沉淀的上报事件（`knowledge-sedimentation`）。 */
export interface KnowledgeSedimentationEvent {
  taskId: string;
  status: "running" | "ok" | "failed";
  /** status=ok：实际写入条数。 */
  written?: number;
  /** status=ok：本次是否补推了此前失败留下的本地提交。 */
  pushedPending?: boolean;
  /** status=ok：逐条判定结果（含未通过的理由）。 */
  items?: KnowledgeWritebackItem[];
  commit?: string | null;
  /** status=failed：失败原因（如「未产出知识沉淀产物」）。 */
  error?: string;
}

// ── 云效 (Aliyun DevOps / Projex) ───────────────────────────────────────────

/** 云效个人访问令牌可访问的组织 */
export interface YunxiaoOrganization {
  id: string;
  name: string;
  description?: string;
}

/** 云效组织下的项目 */
export interface YunxiaoProject {
  id: string;
  name: string;
  customCode?: string;
  description?: string;
}

export interface YunxiaoUserRef {
  id: string;
  name: string;
}

export interface YunxiaoStatus {
  name: string;
  displayName?: string;
  nameEn?: string;
  id: string;
}

/** 云效项目版本（GET .../projects/{projectId}/versions 数组元素）。 */
export interface YunxiaoVersion {
  id: string;
  name: string;
  status?: string;
}

export interface YunxiaoCustomFieldEntry {
  identifier?: string;
  displayValue?: string;
}

export interface YunxiaoCustomFieldValue {
  fieldId: string;
  fieldName: string;
  values: YunxiaoCustomFieldEntry[];
}

/** 云效补录议题请求：由 backfill skill 盘问后写入 backfill-issue.json，Nezha 读取据此创建。 */
export interface BackfillIssueRequest {
  category: "Req" | "Bug";
  subject: string;
  contentSections: BackfillContentSection[];
  customFields: YunxiaoCustomFieldValue[];
  /** 描述末尾的来源行，如「由议题 QHDK-29728 讨论发现」 */
  sourceNote?: string;
}

export interface BackfillContentSection {
  label: string;
  text: string;
}

/** list_backfill_drafts 返回项：目录名（task_id 提示，可能自造）+ 解析后的请求。 */
export interface BackfillDraftEntry {
  taskId: string;
  request: BackfillIssueRequest;
}

/** 云效 Projex 工作项（议题），字段与 SearchWorkitems 响应对齐 */
export interface YunxiaoWorkitem {
  id: string;
  serialNumber: string;
  subject: string;
  description?: string;
  status?: YunxiaoStatus;
  assignedTo?: YunxiaoUserRef;
  creator?: YunxiaoUserRef;
  gmtCreate?: number;
  gmtModified?: number;
  customFieldValues: YunxiaoCustomFieldValue[];
  /** 描述正文中的图片数量（详情接口返回；列表接口为 0） */
  imageCount?: number;
  categoryId?: string;
  logicalStatus?: string;
  workitemType?: { id: string; name: string };
}

/** 云效接口统一分页返回（total 来自响应头 x-total） */
export interface YunxiaoPage<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

/** 云效议题图片准备结果（发起讨论时后端下载到附件目录） */
export interface YunxiaoIssueImagesPrepared {
  paths: string[];
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** 云效提交总结回写结果：评论必已发布；价值评分字段写入状态与警告分开返回。 */
export interface YunxiaoWritebackResult {
  /** 开发向评论 ID */
  devCommentId: string;
  /** 测试向评论 ID（测试内容为空时未发布，为 null） */
  testCommentId: string | null;
  /** 解析出的评分指数（四舍五入），无评分小节时为 null */
  scoreValue: number | null;
  /** 「价值评分」字段是否写入成功 */
  fieldWritten: boolean;
  /** 非阻断警告（评分缺失 / 字段未找到 / 字段写入失败） */
  warning: string | null;
}

/** 云效回写草稿：开发向 + 测试向两条评论。 */
export interface YunxiaoWritebackDraft {
  devComment: string;
  testComment: string;
}

export const PERM_LABELS: Record<PermissionMode, string> = {
  ask: "Ask Permission",
  auto_edit: "Auto-edit",
  full_access: "Full Access",
};

export function permissionModeLabel(
  mode: PermissionMode,
  agent?: AgentType,
  askLabel = PERM_LABELS.ask,
): string {
  if (agent === "codex" && mode === "auto_edit") {
    return "Auto Mode";
  }
  if (mode === "ask") return askLabel;
  return PERM_LABELS[mode];
}

/** Agent 启用状态的最小形状（兼容 AppSettings 及后端返回的子集）。 */
export interface AgentEnabledState {
  claude_enabled?: boolean;
  codex_enabled?: boolean;
  dsh_enabled?: boolean;
}

/** 「发起/运行任务」的 Agent 下拉展示顺序（保持既有视觉排序）。 */
export const AGENT_DISPLAY_ORDER: AgentType[] = ["claude", "codex", "dsh"];
/** 默认/回退 Agent 的优先级：Codex 优先，其次 Claude，最后 DSH。 */
export const AGENT_FALLBACK_ORDER: AgentType[] = ["codex", "claude", "dsh"];

export function isAgentEnabled(
  settings: AgentEnabledState | null | undefined,
  agent: AgentType,
): boolean {
  if (!settings) return true;
  switch (agent) {
    case "claude":
      return settings.claude_enabled !== false;
    case "codex":
      return settings.codex_enabled !== false;
    default:
      return settings.dsh_enabled !== false;
  }
}

export function enabledAgentTypes(settings: AgentEnabledState | null | undefined): AgentType[] {
  return AGENT_DISPLAY_ORDER.filter((agent) => isAgentEnabled(settings, agent));
}

export function firstEnabledAgent(settings: AgentEnabledState | null | undefined): AgentType {
  return AGENT_FALLBACK_ORDER.find((agent) => isAgentEnabled(settings, agent)) ?? "codex";
}

/** 当前 Agent 已禁用时跳到第一个启用项；否则按展示顺序取下一个启用项。 */
export function cycleEnabledAgent(
  current: AgentType,
  settings: AgentEnabledState | null | undefined,
): AgentType {
  const enabled = enabledAgentTypes(settings);
  if (enabled.length === 0) return current;
  const index = enabled.indexOf(current);
  if (index === -1) return enabled[0];
  return enabled[(index + 1) % enabled.length];
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  pending: "Pending",
  waiting_deps: "Waiting dependencies",
  running: "Running...",
  input_required: "Needs confirmation",
  awaiting_review: "Awaiting review",
  detached: "Terminal disconnected",
  interrupted: "Interrupted",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * `TaskStatus` → i18n key 后缀（`status.*`）。集中在此处，避免任务列表行 / 看板卡片
 * 各写一份 switch——新增状态时由穷尽 switch 强制同步，不会静默漏掉某个视图。
 */
export function taskStatusI18nKey(status: TaskStatus): string {
  switch (status) {
    case "todo":
      return "todo";
    case "pending":
      return "pending";
    case "waiting_deps":
      return "waitingDeps";
    case "running":
      return "running";
    case "input_required":
      return "inputRequired";
    case "awaiting_review":
      return "awaitingReview";
    case "detached":
      return "detached";
    case "interrupted":
      return "interrupted";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

/**
 * 是否占用「活跃任务」语义：会创建/持有 PTY、参与启动恢复、占用项目并发槽位。
 * `waiting_deps` 刻意**不**包含在内——等待前置的任务没有 PTY，纳入会误触发恢复逻辑。
 */
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return (
    status === "pending" ||
    status === "running" ||
    status === "input_required" ||
    status === "awaiting_review" ||
    status === "detached"
  );
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface NotificationItem {
  id: string;
  level: "info" | "warning" | "error" | string;
  title: string;
  body: string;
  bodyZh: string | null;
  url: string | null;
  createdAt: string;
  isRead: boolean;
}

export interface NotificationResult {
  notifications: NotificationItem[];
  unreadCount: number;
}

export interface UpdateAsset {
  name: string;
  size: number;
  digest: string | null;
  url: string;
  supported: boolean;
}

export interface UpdateInfo {
  version: string;
  tag: string;
  body: string | null;
  publishedAt: string | null;
  currentVersion: string;
  supported: boolean;
  asset: UpdateAsset | null;
}

export interface UsageWindow {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number | null;
}

export interface ClaudeUsageData {
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
}

export interface CodexUsageData {
  email?: string | null;
  planType?: string | null;
  primary?: UsageWindow | null;
  secondary?: UsageWindow | null;
}

export type UsageSource<T> =
  | { status: "available"; data: T }
  | { status: "unavailable"; reason: string };

export interface UsageSnapshot {
  claude: UsageSource<ClaudeUsageData>;
  codex: UsageSource<CodexUsageData>;
  fetchedAt: number;
}

// ── Skill Hub ────────────────────────────────────────────────────────────────

/** 技能仓库来源：本地目录 path / git 远端 git。 */
export interface SkillSource {
  /** 来源类型 */
  sourceType: "path" | "git";
  /** 本地目录绝对路径（sourceType = "path"） */
  path?: string;
  /** git 远端地址（sourceType = "git"，https:// 或 git@ ssh） */
  url?: string;
  /** git 分支（可选，缺省跟随远端默认分支） */
  branch?: string;
}

export interface SkillHubConfig {
  hubProjectId?: string;
  hubPath?: string;
  createdAt?: number;
  /** 技能仓库来源；旧配置缺省时等价于 path（仅 hubPath） */
  source?: SkillSource;
  /** 上次同步时间戳（毫秒） */
  lastSyncedAt?: number;
  /** 上次同步的 commit hash */
  lastSyncedCommit?: string;
  /** 上次同步错误信息（非空 = 同步失败，正在使用缓存） */
  lastSyncError?: string;
}

export interface Skill {
  /** SKILL 目录名（权威标识） */
  name: string;
  /** frontmatter 的 name 字段，可与目录名不同 */
  displayName?: string;
  /** 解析后的 description，可能包含换行 */
  description?: string;
  /** skill 目录绝对路径 */
  path: string;
  /** frontmatter `scope`：universal = 用户级（所有项目可见）；project = 项目级。缺省 universal */
  scope?: "universal" | "project";
  /** frontmatter `project`：项目技能的目标项目标识（名称/路径关键词），用于安装预选 */
  project?: string;
  /** frontmatter `build-command`：重建技能数据的命令（相对技能目录解析） */
  buildCommand?: string;
  /** frontmatter 解析失败时的错误说明 */
  hasError?: string;
}

export type SkillInstallationHealth = "ok" | "broken" | "diverged";

export interface SkillInstallation {
  skillName: string;
  /** 安装目标项目；universal 安装为空串 */
  projectId: string;
  agent: AgentType;
  /** "universal" | "project"；旧记录缺省按 project 处理 */
  scope?: string;
  /** 项目技能的数据目录（`<项目>/.nezha/skill-data/<技能名>/`）；universal 安装无此字段 */
  dataPath?: string;
  installedAt: number;
  linkPath: string;
  targetPath: string;
  health?: SkillInstallationHealth;
}

/** 项目技能数据目录状态 */
export interface SkillDataStatus {
  dataPath: string;
  exists: boolean;
  fileCount: number;
  lastModified?: number;
}

export type SkillInstallStrategy = "detect" | "skip" | "overwrite" | "cancel";

export interface SkillConflictInfo {
  existingKind: "directory" | "file" | "symlink";
  existingTarget?: string;
  linkPath: string;
}

export interface SkillInstallResult {
  ok: boolean;
  conflict?: SkillConflictInfo;
  alreadyInstalled?: boolean;
  skipped?: boolean;
  cancelled?: boolean;
  installation?: SkillInstallation;
}

export interface SkillDeleteResult {
  ok: boolean;
  removedLinks: number;
}

export interface SetSkillHubResult {
  config: SkillHubConfig;
  project: Project;
  createdNewProject: boolean;
  /** 后端写入后的权威 projects 列表 */
  projects: Project[];
}
