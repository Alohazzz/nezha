# 提案：计划（DeliveryPlan）—— 把「创建 PR / 分支批」升维为议题视角的交付计划

> 状态：**提案（待 maintainer 批复，issue-first）**
> 整理日期：2026-09-22
> 关联：[BranchBatch 消费点清单](../research/branchbatch-consumer-inventory.md)（Scope 一手依据）· [CONTEXT.md](../../CONTEXT.md)（术语表）· [低保真原型](../../.scratch/delivery-plan/mockups/delivery-plan-ui-v1.html)（浏览器打开，含亮/暗）
> 决策来源：wayfinder 地图 `.scratch/delivery-plan/`（charting 盘问 + 6 张决策票）
> **本文解决的问题**：「创建 PR」本质是「哪些议题要改到哪个分支」的**计划**，但现形态以 PR 为中心、成员挂 Nezha 任务、入口藏在项目内右侧面板，与云效议题工作流脱节。

---

## What — 要改成什么样

1. **概念升维**：`BranchBatch`（分支批）→ **`DeliveryPlan`（计划）**——交付容器：一组有序**云效议题**成员＋一条分支＋可选一个 worktree＋至多一个 MR。术语表见 `CONTEXT.md`（「创建 PR / 批 / PR 记录」措辞退役）。
2. **成员换型**：`taskIds` → `issues: PlanIssue[]`（复用方案快照结构，有序＝任务顺序）；**一个议题同时只属于一个计划**；自由文本任务不再是成员。
3. **入口迁移**：
   - 云效议题列表增「**添加到计划**」（多选动作条＋行内），成员一律此后补；创建对话框的「选择议题」勾选区**移除**。
   - 云效议题视图增「**创建计划**」按钮、欢迎页新增「**计划**」视图（侧栏与云效议题同级）也可创建——共用同一创建对话框（沿用现字段：仓库/名称/类型/版本/源分支/基础分支/合并目标/worktree 开关）。
   - **项目内右侧 PR 面板移除**；`SubmitMrDialog` 随迁到计划详情动作行。
4. **欢迎页计划视图**（参考方案看板形态）：项目过滤＋左计划列表＋右详情。详情＝议题表（派生状态／关联方案／动作）＋分支信息＋动作行【添加议题｜提交 MR｜打开｜删除计划】。
5. **议题状态全自动派生**（无手动维护）：未开始 → 讨论中 → 讨论完成 → 执行中 → 已完成，外加 `aborted`（已结束失败/取消）；方案关联经 `Plan.issues` workitemId 自动反查，详情可跳转。
6. **任务强制绑定**：从计划内议题创建的任务（发起讨论／直接开始／待办转任务／存量导入启动共 5 条入口）自动落在计划分支／worktree 上，UI 只读展示「来自计划 X」，不可改；计划内多任务共享 worktree 目录自由并行。
7. **存量就地迁移**：`batches.json` 就地升维（文件名保留），一次性幂等迁移（详见 §3）。

## Why — 动机

- **痛点 1（概念错位）**：当前入口叫「创建 PR」，但用户组织工作的实际心智是「这批议题改到哪个分支」——交付计划。PR 只是计划的收尾动作之一。叫 PR 导致与云效议题流（讨论 → 方案 → 任务）割裂：议题在云效视图管，分支/PR 在项目内右侧面板管，两边看不见彼此。
- **痛点 2（成员错位）**：批成员是 Nezha 任务 id，但计划的组织单位是**议题**——「锁号地址挂号异常问题」下是 QHDK-30439 等议题，任务只是议题的执行过程。现状创建时勾任务（任务还没建）语义倒挂；议题状态（是否已讨论/已执行）在批上完全看不见。
- **痛点 3（入口错位）**：计划是跨任务的组织层，却藏在项目内右侧工具栏；欢迎页已有云效议题/时间线/发起合并等全局视图，计划应同级。
- **期望行为**：在云效议题流里组织计划（添加到计划），在欢迎页总览计划与议题进展，由议题建任务时自动带上分支/worktree——一条议题从「进计划」到「合入」全程单线可见。
- **为何优于备选**：
  - *备选 A：只把文案改成「计划」不换成员*——痛点 2 不解决，状态与关联无法派生；
  - *备选 B：计划吃掉方案（Plan）*——方案是讨论/设计产物（plan.md＋讨论任务），与交付正交，合并会把两套生命周期（讨论定稿 vs 合入收尾）搅在一起；已定「方案不动」；
  - *备选 C：新建独立实体、旧批冻结*——存量在途批/MR 要在两套 UI 收尾，迁移期体验倒退。

## Scope — 影响面

> 依据 [消费点清单](../research/branchbatch-consumer-inventory.md)（约 60 处消费点，逐条带行号）。

**改动面**：
- 前端：`branch-batch/` 5 文件（创建对话框去成员勾选并改文案；`BranchBatchView` 及 PR 面板**移除**，详情能力进新的欢迎页计划视图）、`WelcomePage`（侧栏入口＋计划视图）、`YunxiaoIssueList`/`YunxiaoView`（添加到计划／创建计划入口）、`TaskList`（分组改走 `Task.deliveryPlanId`）、`ProjectPage`（PR 渲染块移除）、`RightToolbar`（PR 入口移除）、`useProjectPanels`、`App.tsx`（5 条建任务入口的绑定）、`RunningView:513/544`（门禁改判）、`i18n`＋硬编码中文措辞、`styles/branch-batch.ts` 迁出 inline 样式债。
- 后端：`batch.rs` → `delivery_plan.rs`（10 命令更名 `*_delivery_plan`）、`storage.rs::Batch` → `DeliveryPlan`（types.ts 双端同步红线）、`codeup.rs`（回写不变，`mr_id=localId` 约定**必须保留**）。
- 数据：`batches.json` 就地迁移；`tasks.json` 补 `deliveryPlanId`；`types.ts`/`storage.rs` Task 加字段。
- 文档：`docs/operation-manual.{md,html}` §6「创建 PR」整章重写为「计划」；`docs/yunxiao-launch-modes.html` 措辞。

**不碰**：
- **终端性能红线**：`TerminalView.tsx`/`terminalShared.ts`/`useTerminalManager.ts`/`pty.rs` 写入链路零改动。
- **方案（Plan）功能本体**：零改动（`Plan.batchId` 休眠字段保留；关联经 workitemId 派生）。
- 「发起合并」视图逻辑：仅加一行「排除已认领分支」过滤（两视图以「有无计划记录」划界，互不引用）。
- 分支命名规范（`batch_branch_name` 与 `pending_mr` 的版本段解析耦合面不动）。
- `batchGrill*`（batch-grill-me 技能开关，与本概念无关，勿误清）。

**不会破坏现有功能的依据**：
- 迁移幂等且留 `.bak`；`task_ids` 读旧不写新（`skip_serializing`），旧 JSON 仍可加载。
- `useWorktree` 迁移时显式落盘，消除「创建缺省 false / 旧记录缺省 true」双默认漂移地雷。
- `worktreeScope` → 5 个右侧面板联动**保留**（文件树/Git 面板的 worktree 上下文依赖它）。
- 修一个现存 bug：`Task.batchId` 无写者导致 `RunningView` 合并/丢弃按钮门禁从未生效——`deliveryPlanId` 补写者后门禁真正生效（这是行为变化，但正是注释意图）。

---

## 1. 数据模型（决策票「DeliveryPlan 数据模型与迁移」S1–S11 全文）

```typescript
// types.ts —— 与 storage.rs::DeliveryPlan 双端同步
export interface PlanIssue {           // 复用方案快照结构
  workitemId: string;
  serialNumber: string;
  subject: string;
  category?: string;
}

export interface DeliveryPlan {        // 原 BranchBatch
  id: string;
  projectId: string;
  name: string;
  kind: BranchKind;                    // feature/fix/patch/project/hotfix
  branch: string;                      // 源分支
  baseBranch: string;
  targetBranch: string;                // 空＝不提 MR
  issues: PlanIssue[];                 // 成员（有序＝任务顺序）；取代 taskIds
  status: "active" | "review" | "merged" | "closed";  // 收敛：删 draft/conflict/approved/rejected
  createdAt: number;
  closedAt?: number;
  useWorktree: boolean;                // 迁移后必须显式
  worktreePath?: string;
  worktreeRepo?: string;
  mrId?: string;                       // 存 localId（codeup.rs:1017 约定，勿改）
  mrStatus?: MrStatus;                 // 保留并接读（详情展示）
  mrSourceSha?: string;                // 删计划防新增提交门禁
}

// Task 新增（取代休眠的 batchId，读侧兼容遗留 batchId 映射一次）
deliveryPlanId?: string;               // 强制绑定的计划；绑定时同步写 worktree* 字段
```

- 删除字段：`taskIds`、`issueSerialNumbers`（并入 `issues[].serialNumber`）、`additions/deletions`（Batch 级从不填充；diff 统计留 Task 级）。
- 状态机实际流转（现存写者仅此 4 态）：`create→active`、`create_mr→review`、`merge→merged`、`delete/close→closed`。

**迁移**（项目首次加载一次性、幂等）：legacy 检测（含 `taskIds` 或缺 `issues`）→ 逐 `taskId` 查 `tasks.json`：有 `yunxiaoWorkitemId` → 入 `issues`；全部（含自由文本）→ 回写 `task.deliveryPlanId`。重写前留 `batches.json.bak`。旧记录缺 `useWorktree` 的缺省 `true` 语义**保留**（早年强制 worktree 时代），迁移时显式化。

**执行语义**（共享目录自由并行）：计划内执行任务 `run_task` 的 cwd ＝ `plan.worktreePath ?? project.path`，旁路 `create_task_worktree`；讨论任务仍项目根只读但写 `deliveryPlanId`。删计划门禁改为 `tasks.any(t => t.deliveryPlanId == plan.id && 非终态)`（不依赖成员反查，换型不失效）。

**强制绑定入口**（查 `workitemId → 计划`，唯一成员制保证单命中；查无维持现状）：议题列表「直接开始」/「发起讨论」、云效待办转任务两路、方案「生成待办」启动、存量导入待办启动。

## 2. 议题状态派生（决策票「议题状态派生规则」全文）

信号源＝`yunxiaoWorkitemId` 匹配的任务 + `Plan.issues` 匹配的方案。从后往前取第一个命中：

| 状态 | 判定 |
|---|---|
| 已完成 | 任一执行任务 `done` |
| 执行中 | 任一执行任务非终态（含 `interrupted/detached`） |
| 讨论完成 | 存在 `finalized/executing/completed` 关联方案且无执行任务 |
| 讨论中 | 讨论任务非终态，或 `draft` 关联方案 |
| 未开始 | 无任务无方案（空态＝「尚未启动」） |
| aborted | 执行任务 `failed/cancelled` 且无在跑——「已结束(失败/取消)」＋可「重新发起」 |

方案关联门槛＝`Plan.issues` 含 workitemId **即关联**（`cancelled` 方案不计入「讨论完成」但展示并标「已取消」）；多方案（主＋追加子方案）全列，创建时间降序。

## 3. UI 形态（决策票「计划视图交互原型」）

低保真原型（浏览器打开，含亮/暗主题）：`.scratch/delivery-plan/mockups/delivery-plan-ui-v1.html`

- **欢迎页「计划」视图**：项目过滤＋左计划列表＋右详情（详情头部动作行常驻：添加议题｜提交 MR｜打开｜删除计划；状态汇总条；议题表）。
- **云效议题「添加到计划」**：多选动作条＋行内入口；弹窗选计划或顺手新建；已属计划的议题标「在计划 X」禁重复。
- **创建计划对话框**：沿用现字段，移除成员勾选；两入口共用；创建后空态引导「去添加议题」。
- 超期（14 天）/ WorkTree 缺失 / 运行程序缺失徽标保留。

## 4. 发起合并视图边界（决策票「发起合并视图的去留边界」）

两视图以**「有无计划记录」**划界、互不引用：计划视图管有计划记录的交付（含 useExistingRemote——有完整记录）；「发起合并」管无主分支（agent 自建/手动推送）的补发 MR 与远端清理，候选列表排除 `branch ∈ plans.branch` 的分支，避免同分支双入口。

## 5. 实施切片建议（供批复后拆 PR）

1. schema＋迁移＋命令更名（无 UI）：`types.ts`/`storage.rs`/`delivery_plan.rs`＋迁移＋测试（现有 round-trip/旧记录缺省测试是护栏）。
2. 任务绑定链路（5 入口＋RunningView 门禁修正）。
3. 欢迎页计划视图＋创建对话框改造＋项目内 PR 面板移除。
4. 云效议题「添加到计划」＋状态派生展示。
5. i18n/文档清理（operation-manual §6 重写、术语替换）。

每片独立可回滚；1 不动 UI、2 是纯逻辑、3/4 各带截图（按 AGENTS.md PR 截图要求）、5 纯文档。

## 6. 验证与风险

- **迁移安全**：迁移前后 `batches.json` 对照 + `.bak` 回滚路径；补 `storage.rs` 迁移测试（legacy JSON → 新结构 + `task_ids` 不再序列化）。
- **删计划门禁**：绑定任务未完成时删除必须被拒（含自由文本遗留任务——靠迁移写入的 `deliveryPlanId`）。
- **mr_id=localId 约定**：`batch_mr_is_merged` 删除门禁依赖它，更名时逐处核对（消费点清单 §2.3）。
- **行为变化明示**：RunningView 合并/丢弃按钮对计划任务将**真正**被抑制（修现存 bug）；计划任务不再有独立「合并 worktree」动作，由计划级删除/合并接管。
