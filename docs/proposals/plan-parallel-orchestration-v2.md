# 方案并行编排（一个方案 = 一个编排任务 × 子 agent worktree 并行 × 尾部统一构建 / 审查）— 需求文档 v2

> **状态：已定案（2026-10-14 讨论产出）；提案 issue
> [#112](https://github.com/Alohazzz/nezha/issues/112)（OPEN，待批复）。未写任何代码。**
> 按 AGENTS.md 的 issue-first 规范，取得 maintainer 批复前不动实现。
>
> **与 v1 的关系**：本文**取代** [`plan-parallel-worktree-unified-build-v1.md`](./plan-parallel-worktree-unified-build-v1.md)
> 的执行主体（v1 的 D1 / D2 / D6 / D8），**继承**其实地实测与构建穿透分析（v1 的 §2.4 成本实测、
> D3 / D9 / D10 / D11），并把 D15「主检出操作禁令」升格为编排者的硬约束。
>
> **一期交付物不是代码，是一次零代码手工演练 + 实测数据。** 见 §7。

---

## 0. 一句话

把「多议题联合方案」的执行从**N 个任务串行排队**改成**一个方案 = 一个编排任务**：编排者按
`deps.json` 的依赖前沿派子 agent 并行改代码，每个议题一个 worktree、一议题一 commit；全部改完
之后在主检出的单点上做**一次**增量构建 + 代码审查，通过后一次性合并回主检出当前分支。

---

## 1. 背景与动机

方案定稿后的执行链现在是**纯串行**：一议题一任务，任务跑在**同一个工作区**，由
`selectAutoStart` 按拓扑序逐个放行。

串行的初衷是保住四件事，它们至今都成立：

1. **议题原子性**——一议题一 commit，不夹带其他议题的改动；
2. **云效回写闭环**——每议题落 `discussion.md`（开发向 / 测试向 / 价值评分三条评论）+ 确定性
   `修改文件` 字段 + 写入价值评分字段；
3. **避免并发 Agent 互相踩**——同一个工作区里两个 agent 同时改代码，改动会互相污染，
   提交内容无法归属；
4. **可观测**——一任务一 PTY 一会话，可中断 / 恢复 / 单议题重跑。

代价是**耗时线性叠加**：一批 N 个无依赖议题的执行时间 ≈ N × 单任务耗时。HIS 上单任务以
十分钟到小时计，一批 3 条就是几小时。

**关键认识**：串行不是架构限制，是默认值。[`src/App.tsx:291`](../../src/App.tsx#L291) 的
`DEFAULT_PLAN_MAX_CONCURRENT = 1`，而调度器 [`src/utils/planQueue.ts:209`](../../src/utils/planQueue.ts#L209)
`selectAutoStart` **本来就实现了「依赖前沿 + 空闲槽位」**——串行只是槽位上限取 1。

---

## 2. 事实基础（2026-10-14 本轮实地核实）

### 2.1 Nezha 侧

| # | 事实 | 证据 |
|---|------|------|
| F1 | 方案待办**跑在当前工作区**，不带 worktree 字段 | [`src/App.tsx:2419`](../../src/App.tsx#L2419) `handleGeneratePlanTodos`；`invokeRunTask(task, task.worktreePath ?? project.path, …)` |
| F2 | 调度器已有「拓扑序 + 依赖前沿 + 槽位上限」，串行 = 槽位 1 | [`src/utils/planQueue.ts:209-241`](../../src/utils/planQueue.ts#L209) |
| F3 | `waiting_deps` 不占槽、无 PTY；且在议题状态派生里被算作**「执行中」** | [`src/types.ts:719`](../../src/types.ts#L719)；[`src/components/delivery-plan/deriveIssueStatus.ts:14`](../../src/components/delivery-plan/deriveIssueStatus.ts#L14) |
| F4 | 议题状态派生按 **`yunxiaoWorkitemId` 匹配任务** | [`deriveIssueStatus.ts:33`](../../src/components/delivery-plan/deriveIssueStatus.ts#L33) |
| F5 | 重复下发去重键 = 「该议题已有任务」 | [`src/App.tsx:2439`](../../src/App.tsx#L2439) |
| F6 | 回写是**任务维度**：弹窗按 `taskId` 生成与发布；幂等标记 `yunxiaoWrittenBackAt` / `yunxiaoCommentId` 在 `Task` 上 | [`src/components/ProjectPage.tsx:921`](../../src/components/ProjectPage.tsx#L921)；[`src/types.ts:383-386`](../../src/types.ts#L383) |
| F7 | 回写素材优先读 `.nezha/drafts/{task_id}/discussion.md` | [`src-tauri/src/agent_assist.rs:1712`](../../src-tauri/src/agent_assist.rs#L1712) |
| F8 | `修改文件` **由系统确定性重算**，三级回落：`base...HEAD` → **按提交信息里的 `#编号` 检索提交** → 最近 20 条 | [`agent_assist.rs:1196-1219`](../../src-tauri/src/agent_assist.rs#L1196) |
| F9 | `修改分支` 取仓库当前分支（或 base） | [`agent_assist.rs:1156`](../../src-tauri/src/agent_assist.rs#L1156) |
| F10 | 知识沉淀 / 补录议题也是**任务维度**（`drafts/{taskId}/knowledge.json`、`backfill-issue.json`） | [`src/utils/yunxiao.ts:527`](../../src/utils/yunxiao.ts#L527)；`yunxiao-issue-execution` 技能「补录议题」节 |
| F11 | 并行闸门统一收在**唯一启动入口**，手动 ▶ 也受同一约束 | [`src/utils/planQueue.ts:124-138`](../../src/utils/planQueue.ts#L124) `hasFreeSlot` |

### 2.2 执行技能与契约侧

| # | 事实 | 证据 |
|---|------|------|
| F12 | 执行技能的流程是「**按方案直接执行改动 → 落 `discussion.md` → 结构自检**」，第 3 步明确引用 `implement` 技能 | SkillHub `yunxiao-issue-execution/SKILL.md`「工作流程」节 |
| F13 | `implement` 技能的最后一条指令是 **`Commit your work to the current branch.`** | `~/.codex/skills/implement/SKILL.md` |
| F14 | 执行提示词的「协作约束」段要求 commit message 含 `#编号` + `closed`，并**手工要求「只提交本议题相关的改动，不要夹带其他议题」**（靠 agent 自律） | [`src/utils/plan.ts:291-296`](../../src/utils/plan.ts#L291) |
| F15 | 方案文档每个议题节**强制含 `### 改动范围与产出物`**，且自检清单**明令「预计改动范围必须写成路径，不能是自然语言」** → **现成的路径白名单** | `yunxiao-plan-discussion/SKILL.md` 第 57 / 89 / 229 行 |
| F16 | 议题级依赖已机器可读（`deps.json`：`dependsOn` + `executionOrder`），Nezha 据此做门禁 | [`src/utils/planDeps.ts`](../../src/utils/planDeps.ts)；SkillHub `yunxiao-plan-discussion/SKILL.md`「方案依赖文件」节 |

### 2.3 Codex 多 agent 能力（本方案的**决定性前提**，已实地证实）

| # | 事实 | 证据 |
|---|------|------|
| F17 | Codex CLI `0.162.1`：feature `multi_agent` = **stable / true**；`multi_agent_v2` = stable / false | `codex features list` |
| F18 | 协作工具齐备：`spawn_agent` / `followup_task` / `send_message` / `wait_agent` / `interrupt_agent` / `list_agents` | 本机 `~/.codex/sessions` 里 multi-agent 会话的开发者提示词原文 |
| F19 | **子 agent 与父 agent 共享同一个 cwd**（原文：All agents share the same container and filesystem… All agents use the same current working directory. As a result, edits made by one agent are immediately visible to all other agents） | 同上；`spawn` 出的子线程 `session_meta.cwd` 与父会话一致 |
| F20 | **并发上限 4 个 agent（含 root）** | 同上原文 |
| F21 | Nezha 拉起 Codex 时**不改任何 feature flag**，故 `multi_agent` 默认生效 | [`src-tauri/src/pty.rs:738`](../../src-tauri/src/pty.rs#L738) `build_codex_cmd` |
| F22 | Nezha 已为 Codex 注入 `SubagentStop` hook，事件回传链路现成 | [`src-tauri/src/hooks.rs:52-60`](../../src-tauri/src/hooks.rs#L52) |
| F23 | 本机**已有真实多 agent 使用史**（8/18–8/31 的会话里用 2–3 个审查子 agent 并行跑 `code-review`，v0.146 起 `multi_agent_version: v2`） | `~/.codex/sessions/**/rollout-*.jsonl` |

> **F19 的直接推论**：implement-spec 里「每个 implementer 在自己的 worktree」**不是硬件级隔离，
> 而是提示词纪律**。worktree 隔离意味着每个子 agent 的每一条命令、每一个 `apply_patch` 都必须
> 指向 worktree 的绝对路径——**一处失手就写进共享工作区**，与其他子 agent 相撞。
> 这是本方案最需要在演练里量化的风险（§7 指标 M2）。

### 2.4 参考方法论：implement-spec 解决了什么、没解决什么

`mattpocock/skills` 的 [`implement-spec`](https://github.com/mattpocock/skills/blob/main/skills/engineering/implement-spec/SKILL.md)
与实现-spec 的思路是：ticket 是一个**带阻塞关系的任务图**，永远存在一条可抓取的
**frontier**；implementer 子 agent 各在自己的 worktree / 分支上开工，完工即由 merger 合并；
随之前沿扩大、再放行更多子 agent；收尾在集成分支上跑一次 `code-review`。

| implement-spec 的构件 | 对本方案的价值 |
|---|---|
| frontier 调度 | **不需要**——Nezha 的 `selectAutoStart` + `deps.json` 已实现，且带异常前置标红、门禁不放行等更严的语义 |
| per-ticket worktree + 分支 | **采用**（D2）——这是保住「一议题一 commit / 一议题一份回写包」的物理边界 |
| 集成分支作为唯一合并目标 | **采用**（D5）——主检出全程只被碰一次，直接回应 v1 的 R-9 事故（`reset --hard` 覆盖未提交改动） |
| 完工即 merge、合并者处理冲突 | **部分采用**（D7 尾部闭环按「先编译、后审查」重排） |
| 一个编排者 + N 子 agent 的拓扑 | **采用**（D1）——但**记录层仍在 Nezha 的任务上**（D4），否则回写 / 看板 / 知识沉淀 / 去重键全线断链 |
| 收尾 code-review 一次 | **采用**（D7） |

---

## 3. 目标与非目标

**目标**

1. 一批 N 条（以 3 条、互相无依赖为主）议题的墙钟耗时从 ≈ N × T 降到 ≈ ⌈N/并发⌉ × T + 尾部一次构建；
2. 保住**议题原子性**：一议题一 worktree、一议题一 commit、一议题一份回写包，且 commit 范围**可证**（D3）；
3. 保住**云效回写闭环**：N 个议题的三条评论 + 价值评分字段照旧逐议题发布（D4）；
4. **主检出安全**：全部改完、构建通过、审查通过之前，主检出不被写（D5）。
5. 老路径（N 任务串行排队）**零改动保留**，可逐方案回退（D10）。

**非目标**：见 §6。

---

## 4. 设计决策（2026-10-14 定案）

### 拓扑与隔离

- **D1｜一个方案 = 一个编排任务（执行层）**
  方案的「开始」新增模式选择：**串行排队**（现状，N 任务）/ **并行编排**（新）。选后者时：
  建 **1 个方案级编排任务**（不绑议题，真正跑 agent，受 `max_concurrent` 串行闸门约束）
  + **N 个议题任务**（绑 `yunxiaoWorkitemId`，状态 `waiting_deps`，**只作记录**）。
  编排任务 = implement-spec 的 `/root`；子 agent = `spawn_agent` 出来的 worker。

- **D2｜每议题一个 worktree + 分支**
  编排者为每个议题 `git worktree add` 一个独立工作树与分支（基线 = 集成分支当前 tip）；
  worker 只在该 worktree 内改动。**集成分支自己也挂一个独立 worktree**，所有合并、冲突
  解决、构建、审查都发生在那里。

- **D3｜commit 由编排者统一执行，范围用方案文档白名单校对**
  - worker **禁止一切 git 写操作**（`add` / `commit` / `stash` / `checkout` / `reset`），只改文件；
    （此举**覆盖** `implement` 技能最后一条 `Commit your work to the current branch.`，见 F13）
  - worker 完工汇报后，编排者对该 worktree 做一次 `git add -A && git commit`，
    message 由编排者按 `<type>(<scope>): <subject> #<编号> closed` 生成；
  - 提交前用 **plan.md 该议题 `### 改动范围与产出物` 的路径清单**校对 `git status --porcelain`，
    越界**不静默**：记入该议题的回写说明（并计入演练指标 M2）。
  - 结果：**commit 范围 = 该 worktree 的全量改动**，可证、可复现、不依赖 agent 自律（修复 F14）。
  - 各 worktree 有独立 index，因此并发提交本身不冲突（冲突只存在于「共享工作区」方案）。

### 记录层与回写

- **D4｜任务仍是「记录层」，回写包按议题编号落盘**
  worker 在各自 worktree 内产出
  `.nezha/plans/<planId>/writeback/<编号>/{discussion.md, knowledge.json}`（契约沿用
  `yunxiao-issue-execution` 的三小节结构 + 结构自检）；编排者完工后 Nezha 读回写包，
  把对应议题任务翻 `done` 并灌入 drafts。
  **这样回写弹窗、幂等字段、看板议题状态、知识沉淀、补录侦测、去重键全部零改造**（F6 / F10 / F4 / F5）。
  - 进度契约：`writeback/<编号>/` 目录出现 ⇔ 该议题成功；失败由编排者另写 failure 清单（编号 + 原因 + 停止轮次）。
  - 价值评分由**每个 worker 自己**跑 `issue-value-scoring` 落进自己的包（它上下文最全）。

### 落地与验证

- **D5｜一次性落地**
  全部议题合并进集成分支、构建与审查通过后，**一次性 merge 回主检出当前分支**（不推送、
  不 `reset --hard`、不 `stash`、不自动切分支）→ 继承并强化 v1 的 **D15 主检出操作禁令**。

- **D6｜一期零构建**
  worker 阶段**不做任何构建**：只改代码 + 静态自检（方案要求的符号 / 接口是否真实存在、
  改了接口是否列出被引用方、有没有只改一半）。构建与审查全部后置到尾部单点。
  - 为什么敢：D3 让每个 commit 与议题一一对应，尾部构建的每个错误文件都能**反查到是哪个
    议题的 commit 碰的**，可生成指认到议题的修复任务。
  - 二期升级路径：worktree 内单工程轻检（需要 junction 借用 + 双重定向，即 v1 的 D3，重新
    打开 R-1 / R-2 穿透议题）。

- **D7｜尾部闭环：先编译、后审查、审查后重新编译**
  1. 集成分支上做**一次增量构建**（编译范围 = 变更 DLL ∪ HintPath 引用方，见 v1 D10）；
  2. 构建失败 → 按「错误文件 → 议题 commit」派修复子 agent，**上限 2 轮**（v1 D11）；
  3. 编译通过才跑 `code-review`（可并行多个审查子 agent，本机已有先例）；
  4. 派**一个** worker 统一修审查问题 → 重新构建确认；
  5. 超限 / 冲突未解 / 构建持续失败 → **挂起 + 系统通知**，等人工决策；**永不自动 revert**。

- **D8｜单议题操作收敛到编排任务**
  议题任务在并行编排模式下**只读**（不开 ▶、不按 `planQueue` 放行），仅保留「跳过本议题」。
  异常恢复 = `resume` 编排任务 + 注入指令（如「只重跑 #QHDK-30439」），编排者只重建该议题的
  worktree 与分支。

### 开关与阶段

- **D9｜启动时逐方案选择**
  方案预览页在现有「开始」旁提供模式选择（串行排队 / 并行编排）。**老路径零改动保留**，
  适合并行的方案（≥2 条无依赖议题）才走新路；强依赖链继续走串行。

- **D10｜前置条件（编排模式生效的必要条件，不满足即不启用）**
  - agent 为 **Codex**（`multi_agent` 提供 `spawn_agent`；Claude Code 的 Task 子 agent 语义不同）；
  - 权限模式 **`full_access`**——`workspace-write` 沙箱下 worktree 若落在项目目录外会被拒写，
    子 agent 无人在场审批；
  - worker 并发 ≤ **3**（Codex 上限 4 含 root，F20）；议题数 > 3 时按前沿滚动放行。

- **D11｜一期 = 手工演练，不写代码**
  先把编排流程**手工**跑一遍（零代码、零 Nezha 改动），拿到实测数据再决定写技能与集成（§7）。

---

## 5. 待定项（含建议答案，实施前逐条确认）

| # | 待定项 | 建议答案 |
|---|--------|----------|
| O1 | **议题任务不能被调度器放行**（真实陷阱）：`waiting_deps` 的议题任务会被 [`selectAutoStart`](../../src/utils/planQueue.ts#L209) 当成「无依赖待启动」**真的起 PTY 重复干活** | 给记录类任务加显式标记字段（如 `planShell?: boolean`），调度器跳过带标记者；⚠️ 加字段必须同步 [`types.ts`](../../src/types.ts) 与 [`storage.rs`](../../src-tauri/src/storage.rs)（AGENTS.md 硬规则） |
| O2 | worktree 物理位置：项目内 `<project>/.nezha/worktrees/<planId>/<编号>/`（沙箱友好）vs HIS 现有 `[worktree] base_path`（在项目外，仅 `full_access` 可写） | 默认放项目内；演练时两种都试，用数据决定 HIS 的取值 |
| O3 | 并发数与议题数的关系 | worker ≤3；>3 条按前沿滚动（implement-spec 第 6 步） |
| O4 | worker 的 prompt 从哪来 | 直接复用现有 [`buildPlanExecutionPrompt`](../../src/utils/plan.ts#L244) 的**每议题切片**，只替换「协作约束」段（worktree 绝对路径 / 禁 git / 路径白名单 / 不构建） |
| O5 | 编排者自身的提示词来源 | 方案全文 + `deps.json` + 每议题切片 + 编排契约（新技能，见 §9） |
| O6 | 进度契约的载体 | `writeback/<编号>/` 出现 ⇔ 成功；`failures.json` 记录失败清单 |
| O7 | 云效关单时机 | `#编号 closed` 的提交只在**最后 merge + 推送**后才真正关联 / 关单；需确认云效是否要求默认分支（今天也是人工推） |
| O8 | 演练验收指标 | wall clock 加速比 / commit 归属正确率 / 回写四字段准确率 / 首轮构建通过率 / worker 越界次数（§7） |

---

## 6. 明确不做（本期边界）

- **不动 `selectAutoStart` / `deps.json` / 依赖门禁**——frontier 调度已经有了；
- **不做集成分支的远端 PR 流程**（v1 §5 的「集成分支」禁令由 D5 改写为「本地集成分支 + 一次性合并」）；
- **不做子模块的可写 worktree 化与双层合并**（涉子模块的议题仍走降级路径，二期再议）；
- **不做多任务同屏终端**（架构限制一次只挂一个 xterm）；
- **不改回写链路的取数逻辑**——F8 的「按 `#编号` 检索提交」在 D3 之下天然获得议题级精度；
- **不做 worker 阶段的构建**（D6）。

---

## 7. 一期：手工演练方案与验收指标

**目的**：在写任何代码之前，用真实仓库验证四个未知量。**全程零代码、零 Nezha 改动。**

> 可执行步骤、编排者契约提示词与数据记录表见
> [`plan-parallel-orchestration-v2-rehearsal.md`](./plan-parallel-orchestration-v2-rehearsal.md)。

**样本**：测试项目 `H:\Project\nezha-plan-test-project` 上的 `fixture-plan-parallel`
（TEST-101 / TEST-102 / TEST-103，`deps.json` 三条 `dependsOn` 全空；尾部判据是
`npm test` 由 18 用例 / 15 通过 / 3 失败转为全绿）。该样本刻意保留了「两个议题改同一个文件
的不同区域」这一合并面，专门验「分片改动能不能干净合并」。
**不在 HIS 上试**——HIS 留到机制成立之后（本方案的三期集成），避免在真实业务仓库上
验证尚未定型的流程。

**前置**：权限 `full_access`（`workspace-write` 沙箱会挡掉 worktree 写入）、
Codex `multi_agent` 生效（`spawn_agent` 可用）。

**步骤**

1. 记录**串行基线**：同批议题按现状跑（或取最近一次同规模方案的实际耗时）。
2. 主检出不动；建集成分支 + 集成分支 worktree。
3. 为 3 个议题各建 worktree + 分支，记录各自基线 commit。
4. 手工扮演编排者：用一个会话按契约 `spawn_agent` 出 3 个 worker，每个 prompt 说明
   「只在 `<worktree 绝对路径>` 内改动 / 禁止一切 git 写操作 / 不构建 / 本议题范围白名单」。
5. worker 汇报完工 → 逐个 `add -A` + commit（带 `#编号 closed`）→ 路径白名单校对，越界记数。
6. 逐个 merge 进集成分支（记录冲突次数与解决方式）。
7. 尾部（测试项目上即 `npm test`，HIS 上为增量构建）→ 记录首轮通过率与错误归属映射是否可行
   → `code-review` → 修 → 重新验证。
8. 产出 3 份回写包 → 人工核对四个字段（`修改分支` / `修改文件` / `测试步骤` / 价值评分）。
9. **本轮不真的落地**：主检出停在原分支不动，只用
   `git merge-tree --write-tree <主检出分支> <集成分支>` 做落地冲突 dry-run，
   核对主检出是否全程未被写。

**指标**

| 指标 | 口径 |
|------|------|
| M1 加速比 | 并行链墙钟（含尾部构建） vs 串行基线 |
| M2 隔离纪律 | worker「写进共享工作区」的越界次数；worktree 内是否出现跨议题误改 |
| M3 归属正确率 | 一议题一 commit、无夹带的达成率；`修改文件` 四字段与人工核对的一致率 |
| M4 尾部成本 | 首轮构建通过率；错误→议题的反查准确率；审查发现数与被采纳数 |
| M5 代价 | 每议题 worktree 开销（v1 实测：`worktree add` 11.0 s + 子模块只读初始化 6.2 s）；token 用量（可从子线程 rollout 统计） |

**通过条件（建议）**：M1 明显优于基线 **且** M2 越界为 0 或可被机制消除 **且** M3 不低于现状。

---

## 8. 验收口径（端到端，草案）

1. 模式选择为「串行排队」时，行为与现状**完全一致**（回归基线）。
2. 3 条无依赖议题走并行编排：墙钟显著低于串行基线，且全程无人值守。
3. 主检出在落地之前**无任何写入**（可用文件监控 / 分支状态验证）。
4. 一议题一 commit，message 含 `#编号 closed`；无夹带（路径白名单校验通过或越界有记录）。
5. N 个议题任务在完成后被物化为 `done`，回写弹窗可逐议题生成并发布三条评论，
   `修改文件` 与 `价值评分` 写入正确，幂等标记正确。
6. 构建失败 → 自动生成指认到议题的修复任务；2 轮后仍失败 → 挂起 + 通知，无自动 revert。
7. 编排任务中断后 `resume` + 注入「只重跑 #编号」能恢复单个议题而不重跑全部。

---

## 9. 实施顺序（issue-first）

1. **提案 issue**（本文件为正文）→ 等 maintainer 批复；
2. **一期：手工演练**（§7，零代码）→ 数据回填本文 §7 指标表，据此确认 / 修正 D6、O2、M1 通过条件；
3. **二期：技能**——SkillHub 新增编排技能（暂名 `yunxiao-plan-orchestration`），承载
   编排契约：前沿计算、worktree 生命周期、worker prompt 组装、禁 git 约束、编排者统一提交、
   白名单校对、尾部构建 / 审查 / 修复循环、回写包落盘契约。
   > 按 AGENTS.md：技能统一放 SkillHub，创建后询问是否提交推送。
4. **三期：Nezha 集成**——模式选择入口、预物化 N 个议题任务（含 O1 的标记字段 + `types.ts` /
   `storage.rs` 同步）、回写包侦测与物化、failure 清单驱动的状态与通知。
5. **四期（可选）**：worker 阶段单工程轻检（v1 D3 的 junction + 双重定向）。

---

## 附录 A：一句话记住的约束

- 主检出上只允许 **append 类**操作：merge / commit / 只读命令；`reset --hard`、`clean`、
  `checkout -- <path>`、`stash` **一律禁止进入自动化路径**（v1 D15）。
- worker 只改文件、不碰 git；commit 由编排者按议题做，且范围有白名单可校。
- 记录层永远是 Nezha 的任务：**没有议题任务，就没有回写、没有看板、没有去重键**。

---

*讨论记录来源：2026-10-14 `grilling` 会话（逐条决策 11 轮 + 事实核查：Nezha 源码、SkillHub 技能契约、
Codex `0.162.1` feature 列表与本机 multi-agent 会话 rollout）。*
