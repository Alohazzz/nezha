# 需求：跨项目协同（Cross-Project Solution）v1 —— 接缝账本 + 契约传播 + 联调验收

> 状态：**草稿 / 未成熟，暂不提交评审**。方向与调研证据已就位，但设计（尤其契约账本的
> 提取成本、联调环境的落地复杂度、是否值得引入 Solution 层）尚未收敛，**不要据此开 issue 或动工**。
> 后续若成熟再走 AGENTS.md「提交前流程」（issue-first）。
> 承接：`GitRoot` 多仓库工作区（`src/types.ts:16`）、`Task.worktreeRepo`（`src/types.ts:258`）、
> `BranchBatch` 可独立验收批次（`src/types.ts:124`）、`TimelineView` 跨项目时间线
> 调研依据：`docs/research/multi-project-agent-landscape.md`
> 本文件只描述设计与范围，**不含实现**。

---

## 0. 先回答架构问题：不是「一个凌驾于所有项目之上的讨论框」

直觉上会想要一个浮在所有项目之上的聊天界面。**这个方向是错的**，有一个硬约束：

agent 的执行面（终端 PTY、文件树、Git 面板、权限规则）全部**绑定在具体 `cwd`** 上。一个悬浮在所有项目之上的聊天框，要么没有工具可用，要么 `cwd` 是模糊的——agent 无法安全执行。这正是 Paseo 卡住的位置：它的 composer 是 per-workspace，且明确拒绝跨项目 split pane（[paseo#2174](https://github.com/getpaseo/paseo/issues/2174)）。

**因此聊天框是入口（intake），不是工作区。** 设计拆成三个面，各有明确归属：

| 面 | 位置 | 是否「凌驾于项目之上」 | 承载什么 |
|---|---|---|---|
| **入口 / intake** | 全局，瞬时 | 是 | 接收自由文本 → 产出**路由提案** → 建任务。不承载执行。 |
| **协同面板 Solution View** | 全局，常驻 | 是 | 展示**依赖图 / 看板**（跨项目任务的状态与依赖）。不是聊天。 |
| **讨论** | 挂靠在对象上 | 否 | 任务对话留在项目内；接缝争论挂在**契约点**上；跨项目级是**一份可编辑的共享规格（Solution Brief）**。 |

「凌驾于所有项目之上」的合法形态只有一种：**Solution Brief**——一份可编辑的共享规格文档，注入两端 prompt。它是**文档**，不是聊天记录。这一点很关键：聊天记录无法版本化、无法作为契约、无法被 diff，而跨仓库协同恰恰需要这三样。

### 0.1 关键判断：你可能不需要 Solution 层

代码查证发现 Nezha **今天就已支持「一个项目 + 多个 git 仓库」**：

- `NewTaskView.tsx:88` 有 `roots: GitRoot[]` 选择器，切换 sub-repo 时代理到 `useGitRoots.setSelectedRoot`，BranchBar / Git 面板跟随切换；
- `Task.worktreeRepo`（`types.ts:258`）记录任务落在哪个 sub-repo，启动校验在 `NewTaskView.tsx:454`；
- `BranchBatch.worktreeRepo`（`types.ts:155`）同样支持批归属到 sub-repo。

所以按**耦合性质**分两种场景，只有一种需要 Solution 层：

| 场景 | 特征 | 该用什么 | 需要 Solution 层吗 |
|---|---|---|---|
| **持久耦合** | 前后端是同一个产品，永远一起发布、同一 owner | **一个 Project + 多个 GitRoot**（今天就能做） | **不需要**。只需接缝账本 + 契约检测。 |
| **瞬态耦合** | 两个独立项目、独立 owner，为一个特性临时协作，上线即解散 | **Solution**（跨项目交付单元） | 需要 |

**明确反对**把 Solution 做成 "project of projects"：`Project` 是持久的（`ProjectRail` 常驻、`projects.json` 持久化），Solution 是瞬态的，混进 `Project` 会污染导航与存储模型。

---

## 1. 背景事实（代码查证）

### 1.1 已存在、可直接复用的原语

- **多仓库工作区**：`GitRoot { path, name, isRoot }`（`types.ts:16`），后端 `discover_git_roots_blocking`（`git.rs:379`，`discover_git_roots` 命令已注册于 `lib.rs:392`）。项目根非 git 时 `roots` = 每个子 git 目录。
- **任务级仓库归属**：`Task.worktreeRepo`，消费点遍布 `App.tsx`（`:1169`/`:1180`/`:1203`/`:1431`/`:2333`）、`useGitRoots.ts:46`、`useWorktreeDiffStats.ts:45`。缺省回落 `project.path`，向后兼容。
- **可独立验收的交付单元**：`BranchBatch`（`types.ts:124`）已有 `taskIds: string[]`（顺序即验收顺序）、状态机 `draft|active|review|conflict|approved|merged|rejected|closed`、`worktreePath` / `worktreeRepo` / `additions` / `deletions`、Codeup MR 集成（`mrId` / `mrStatus` / `mrSourceSha`）、云效议题门禁（`issueSerialNumbers`）。后端 `batch.rs` 有 `BatchView` / `get_branch_batch` / `close_branch_batch` / `MergeBatchResult` / `BranchConflictCheck`。
  - **但 `BranchBatch.projectId` 是单数** —— 这是它无法直接承载跨项目协同的唯一结构性缺口。
- **跨项目聚合视图的先例**：`WelcomePage` 内的 `TimelineView`（跨项目任务时间线，今天/昨天/更早，按项目二级分组）；跨项目 `CodeupMr`（`types.ts:190`，欢迎页合并审核）。
- **持久化分层**：`~/.nezha/projects.json`（Project[]）、`~/.nezha/projects/<projectId>/tasks.json`（Task[]，每项目独立）。

### 1.2 关键约束（来自调研，会直接约束设计）

- **所有 agent 判断「属于哪个项目」的机制只有一招**：process `cwd` + 向上遍历找指令文件。Codex 从 cwd 向上遇 `.git` 即停（不再向上），把根到 cwd 的 `AGENTS.md` **拼接**，硬上限 **32 KiB**；Claude Code 同样是**拼接而非覆盖**（官方 memory 文档："All discovered files are concatenated into context rather than overriding each other"）。
- **坑**：`AGENTS.md` 官方规范写的是 "closest one takes precedence"（覆盖），但 Codex / Claude Code 实现都是**拼接**。设计上下文合并时**不能按规范字面意思**。
- **跨根能力受限**：Claude Code `--add-dir` **不发现**那些目录的 `.claude/` 配置（需 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`）；Codex `--add-dir` 仅在 `workspace-write` 以上生效。
- **市面尚无自动路由**（详见调研文档第 3、4 节）。因此 v1 不做全自动路由。

---

## 2. What — 设计

### 2.1 核心原则：把「接缝」变成一等对象

跨仓库协同**不是**「让一个 agent 同时看两个仓库」。两个仓库塞进一个 context window 必然稀释（HN 多处报告 compaction 后 agent 偏离指令）。正确做法：

> **把接缝显式化为一份可版本化、可检测、可验证的账本（Contract Ledger）。接缝是压缩后的契约——小到能进上下文，精确到能生成代码和测试。两端 agent 不需要互看仓库，各自对齐同一份契约。**

### 2.2 接缝账本（Contract Ledger）

新增实体，粒度是**接口点**而非仓库：

```typescript
interface ContractPoint {
  id: string;
  solutionId: string;
  kind: "http" | "type" | "event" | "schema" | "env" | "file";
  /** 提供方：哪个项目的哪个符号/路径 */
  provider: { projectId: string; repoPath?: string; symbol: string };
  /** 消费方列表 */
  consumers: { projectId: string; repoPath?: string; symbol: string }[];
  /** 可选：规范工件引用（有则优先，见 2.3） */
  specRef?: { path: string; pointer?: string };
  /** 契约内容指纹，用于检测变更 */
  fingerprint: string;
  version: string;
  lastChangedByTaskId?: string;
  /** 来源：自动提取 or 人工标注（腐化风险不同，见 6.2） */
  origin: "extracted" | "annotated";
}
```

**生成策略（可靠性降序）：**

1. **规范工件优先**（确定性）：OpenAPI / proto / GraphQL SDL / DB migration 是权威来源，直接解析。
2. **符号级提取**（确定性）：框架路由注册（Express / FastAPI / Spring 注解）、共享包类型导出、env 变量声明。
3. **LLM 语义扫描**（兜底）：仅当仓库无规范工件时使用，且**只喂顶层目录 + 清单 + 依赖文件**，**不喂全仓库**——避免上下文稀释。

首次生成是**草稿**，需人工确认后固化。

### 2.3 变更检测（「自动通知」的引擎）

任务完成后触发，按可靠性降序、能用确定性绝不用模型：

1. **规范 diff**：后端改了 `openapi.yaml` / `.proto` → 直接 diff 出新增/修改的 operation。最可靠。
2. **符号级 diff**：路由注册变化、共享包导出的类型变化、env 新增、migration 文件。
3. **LLM 兜底**：输入 =「该任务 diff + 接缝清单」，问模型「这次改了哪些对外可见接口」。输出结构化 `ContractChange[]`。**故意不让它看全仓库。**

```typescript
interface ContractChange {
  contractPointId: string;
  type: "added" | "modified" | "removed";
  impact: "breaking" | "additive" | "internal";
  evidence: { path: string; hunkRef: string };
  summary: string;
}
```

### 2.4 传播：变更 → 派生任务（带依赖边）

检测到 `POST /api/orders` 新增，且清单里有 `consumer: frontend` 的边 → 自动派生**前端任务**。关键是它不是一条通知，而是一个**有依赖边的任务**：

- prompt 预填：接口 delta、生成的 client stub、请求/响应示例、后端任务链接；
- `dependsOn: [backendTaskId]`，在后端契约冻结前保持 blocked；
- 通知（`NotificationBell` / 任务列表）只是**呈现形式**，worker 是任务本身。

### 2.5 联调验收（Solution Environment）

这是这条链的**验收门**，也是 v1 最有价值的部分：

- 把 N 个成员仓库的 worktree **并排物化**到一个 solution 工作目录；
- 分配**隔离端口**（每个 worktree 自己的 localhost，避免端口撞车）；
- 按 `.nezha` 中的 setup 脚本起服务；
- 跑**从接缝账本自动生成的契约测试**（真实调用每个接口，校验响应结构与前端期望类型一致）；
- **契约测试通过 = 该跨仓库特性可验收。**

### 2.6 契约先行 vs 后端先行（必须现在定的决策）

| 模式 | 流程 | 能否并行 | 权衡 |
|---|---|---|---|
| **契约先行**（建议默认） | 先在接缝层冻结接口（改账本 + 生成 stub）→ 前后端 agent **各自对着冻结契约并行实现** | ✅ | 唯一能安全并行的模式；要求先想清接口 |
| **后端先行** | 后端先实现完 → 检测器派生前端任务 → 串行 | ❌ | 简单、慢；接缝是「实测」出来的而非「声明」的 |

市面**没有任何产品把契约先行做成工作流**——Vibe Kanban 支持多 repo workspace 了，但收口仍靠人「Create a PR for each repository」再按依赖顺序手动合并。**这是空白区。** 若倾向串行起步，v1 体量会小很多（见第 7 节分期）。

### 2.7 界面设计（回答「凌驾于所有项目之上」的落点）

**入口**：`NewTaskView` 增加一个「跨项目」开关，或独立的全局入口。输入自由文本 → 路由提案卡片：

```
┌─ 路由提案 ─────────────────────────────────────────┐
│ 检测到该任务同时涉及 2 个项目：                      │
│ ● frontend  (置信度 0.92)  证据: 命中 src/api/*.ts  │
│ ● backend   (置信度 0.88)  证据: 命中 routes/*.py   │
│ 接缝: POST /api/orders (新增)                        │
│ [ 建立 Solution ]  [ 只建单项目任务 ]  [ 改 ]        │
└─────────────────────────────────────────────────────┘
```

**协同面板**：`SolutionView`，作为 `TimelineView` 的**兄弟**挂在 `WelcomePage`（不新开顶层导航）。内容是依赖图 / 看板：

```
┌─ Solution: 订单导出功能 ────────────── 状态: 联调中 ─┐
│  backend  ✓ 新增 POST /api/orders/export            │
│      └─dependsOn→  frontend  ● 接入导出按钮          │
│  [契约账本 3 条]  [联调: 端口 4101/4102  ● 2/3 通过] │
└──────────────────────────────────────────────────────┘
```

点任务卡片下钻回该项目的 `TaskPage`——**对话、终端、Git 全部保持原样**，不新建一套执行面。

**讨论**：任务对话留在项目内；契约点可挂讨论；solution 级只有一份 `Solution Brief`（可编辑文档，注入两端 prompt）。

---

## 3. Why — 动机

1. **日常真实痛点**：前后端分离已是主流形态，跨仓库改动（后端加接口 → 前端接入）目前完全靠**人肉传递**，且传递时机、内容、验收全靠自觉。
2. **市面空白**：调研确认「聊天框自动知道任务该去哪个项目」在 2026-09 **不存在**；Paseo 明确拒绝多仓库（PR #1461 / issue #1972 / #1530 / #2174 全部关闭）；跨仓库的**协同语义**（接缝、契约传播、联调验收）是公开记录里的真空地带。
3. **Nezha 已有地基**：`GitRoot` + `worktreeRepo` + `BranchBatch` + `TimelineView` 四块原料就位，缺的只是「接缝账本 + 路由 + 编排」这一层。相比从零做，边际成本低。
4. **为什么这个改法优于备选**：
   - 优于「多仓库塞一个 agent」：避免上下文稀释，且能解决**时序**问题（后端今天改接口，前端怎么知道）。
   - 优于「project of projects」：不污染持久导航模型。
   - 优于「全自动路由」：误投成本远高于多问一句（见 4.3）。

### 3.1 与现有机制的边界

- **不取代 `BranchBatch`**：Solution 是它的**跨项目升级版**。单项目内的交付批次继续用 `BranchBatch`；跨项目才引入 Solution。两者共用状态机语义。
- **不取代 `GitRoot`**：持久耦合的前后端走 `GitRoot` 路径，不强制升级为 Solution。
- **不取代 `TimelineView`**：Timeline 是只读时间线，SolutionView 是可操作面板，并列存在。

---

## 4. Scope — 影响面

### 4.1 数据 / 迁移

```typescript
// 新增
interface Solution {
  id: string;
  name: string;
  memberProjectIds: string[];
  /** 共享规格文档路径（相对 .nezha/solutions/<id>/） */
  briefPath?: string;
  status: "draft" | "active" | "syncing" | "verifying" | "done" | "closed";
  createdAt: number; closedAt?: number;
}

// Task 新增
interface Task {
  // ...
  solutionId?: string;          // 归属哪个跨项目工作项
  dependsOn?: string[];         // 任务间依赖边（现仅有 batchId，无依赖语义）
  contractChanges?: string[];   // 本任务产生/消费的 ContractPoint id
}

// BranchBatch 可选新增（若走批路径）
interface BranchBatch {
  // ...
  solutionId?: string;
}
```

- **`types.ts` 与 `storage.rs` 必须同步**（AGENTS.md 硬性要求），否则新字段序列化时被静默丢弃。
- 新增持久化：`~/.nezha/solutions.json`（Solution[]）、`~/.nezha/solutions/<id>/contracts.json`（ContractPoint[]）、`~/.nezha/solutions/<id>/brief.md`。
- 全部新字段**可选 + 缺省回落**，旧数据无需迁移。

### 4.2 后端（Rust `src-tauri/`）

- 新模块 `solution.rs`：Solution CRUD、账本读写、change 检测、依赖派生。
- 契约提取器：按 2.2 三级策略，可能需新依赖（OpenAPI/proto 解析）。**若引入新 crate 需在提案评审时确认。**
- 联调环境：端口分配器 + 并排 worktree 物化 + setup 脚本执行。
- 契约测试生成与执行。
- **所有命令遵循 AGENTS.md**：路径参数 canonicalize + `starts_with` 校验；文件 I/O / 进程 / 网络一律 `tokio::task::spawn_blocking` + `kill_on_drop(true)` + `timeout`；新命令在 `lib.rs::invoke_handler!` 注册；Mutex 用 `parking_lot`，不裸 `.unwrap()`。

### 4.3 前端（`src/`）

- `SolutionView`（新目录 `src/components/solution/`，遵循「不超过 400 行、下沉子目录」规范）。
- 路由提案卡片（`NewTaskView` 或全局入口）。
- 契约账本编辑器 / 查看器。
- **样式一律进 `src/styles/` 模块，禁止 `style={{}}`**；用 `className` + `data-*` 表达状态。
- 新增列表（依赖图、契约点）注意虚拟化。

### 4.4 安全（重要）

- **路由提案必须有据可查 + 一键确认**，不做静默全自动路由。
- **只读类分析**（纯查询、无写入）可静默自动路由；**任何会写代码 / 发 PR 的动作必须确认**。
- 跨项目权限：agent 可触达多个 repo 时，需在提案里明确路径白名单与爆炸半径约束（参考 Claude Code「权限路径不锚定 repo 根」的坑）。

### 4.5 不触及

- **终端性能红线**：本设计不改 `useTerminalManager.ts` / `TerminalView.tsx` / `terminalShared.ts` / `pty.rs` 的写入与 IME 路径。联调环境复用现有 PTY/终端链路，不新增写入通路。
- 现有单项目任务流程、`BranchBatch` 现有语义、`GitRoot` 发现逻辑。

---

## 5. 明确不做（v1 非目标）

1. **全自动路由**（无确认直接建任务）——误投成本过高，见 4.4。
2. **自动改多仓库代码**——只派生任务，不代替人做契约判断。
3. **隐式契约的静态检测**——「amount 单位是分」这类语义约定静态分析抓不到，只能靠联调失败回写（见 6.2）。
4. **project of projects**——Solution 不进 `Project` 模型。
5. **跨机器 / 云端执行**——v1 仅本地。
6. **自动生成并提交 PR**——v1 只到「契约测试通过」，提交仍由现有 Codeup MR 链路承担。

---

## 6. 风险与诚实的边界

### 6.1 隐式契约检测不了

语义约定（单位、幂等性、必填性）静态分析抓不到，只有联调失败时才暴露。

### 6.2 账本会腐化 —— 必须有回写飞轮

契约测试失败时，把新发现的隐式依赖**写成一条新边**（`origin: "annotated"`）。这份账本必须是**活的**，不是一次性生成的。能自动提取的（OpenAPI/proto）绝不手写；手写部分要在 CI 做一致性校验防漂移。

### 6.3 别指望全自动

检测 → 派生任务可以自动；但「这个变更该不该影响前端」的判断要给证据 + 一键确认。**误建一条前端任务成本很低，误改前端代码成本很高。**

---

## 7. 分期建议

| 阶段 | 内容 | 价值 | 依赖 |
|---|---|---|---|
| **P0** | 持久耦合场景：一个 Project + 多 `GitRoot` + 接缝账本（只做规范提取）+ 任务级账本展示 | 立即可用，无新概念 | 现有 `GitRoot` |
| **P1** | 契约变更检测 + 派生带 `dependsOn` 的前端任务 + 通知 | 「自动通知前端」闭环 | P0 |
| **P2** | Solution 实体 + `SolutionView` + 路由提案卡片 | 瞬态跨项目协作 | P1 |
| **P3** | 联调环境（隔离端口 + 并排 worktree + 契约测试） | 验收门，最高价值也最难 | P2 |
| **P4** | 契约先行模式 + Brief 注入 | 安全并行 | P3 |

> 若决策倾向**后端先行**（串行起步），可只做 P0 + P1 + 部分 P3，跳过 P2/P4，体量显著减小。

---

## 8. 验证

- **单测**：契约提取（OpenAPI/proto 解析）、fingerprint 变更检测、端口分配器、依赖派生逻辑。
- **集成测试**：一个 fixture（前端 repo + 后端 repo），后端加接口 → 断言派生前端任务 → 跑契约测试。
- **前端**：新增组件的渲染测试；`SolutionView` 各状态（空态 / 检测中 / 冲突 / 完成）。
- **UI 改动需附截图**（AGENTS.md 要求）：暗色 + 亮色各一，多状态覆盖。建议原型到位后补。
- **回归红线**：确认未触碰终端写入 / IME 路径（4.5），跑现有终端相关测试。

---

## 9. 待 maintainer 确认的决策

1. **契约先行** 还是 **后端先行** 作为默认？（决定 P2/P4 是否在 v1 范围）
2. 是否接受 **Solution 作为 `BranchBatch` 的跨项目升级**（共用状态机语义），而非全新并行概念？
3. 契约提取是否允许**引入新 crate**（OpenAPI/proto 解析）？还是 v1 只做 ELF（手写 + LLM 兜底）？
4. **持久耦合**场景是否先走 P0（纯 `GitRoot`，无 Solution），验证后再决定 P2 是否必要？
