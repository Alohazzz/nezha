# 需求：云效议题详情 + 内容补全 + 按类型引导讨论（v2）

> 状态：**需求文档（待评审）**——grilling 决策树已走完，进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha（本地 remote 实测）
> 承接：`docs/proposals/yunxiao-issues-integration-v1.md`（v1：列表 + 导入 + 待办列）与
> `docs/proposals/yunxiao-filters-v2.md`（过滤 v2，并行迭代，明确不做详情页）。

---

## 背景事实

- v1 已落地：云效全屏列表（分类 Tab + 服务端过滤）、导入待办、看板待办列；
  点击待办卡片目前进 `TodoTaskView`，只显示导入时的 `task.prompt`
  （议题编号 + 标题 + 描述片段 + 状态/负责人/优先级/ID），**无详情查询、无云效链接**。
- 官方存在 `GetWorkitem` 接口；REST 路径与返回字段**实现时用真实 token 复验**（沿用仓库惯例）。
- 现有 `buildYunxiaoPrompt`（`src/utils/yunxiao.ts`）不含云效链接——「附上链接」是新增量。
- 导入待办时 `agent` 硬编码为 `claude`（`App.tsx::handleImportYunxiaoIssue`），
  项目配置 `agent.default` 只作用于新建任务，不作用于云效导入/待办流程。
- `src-tauri/src/agent_assist.rs` 已有轻量 headless 调用模式
  （claude `-p` / codex `exec --ephemeral`，超时 + kill_on_drop + 标签化输出解析），
  补充表单预填直接复用该模式，不新造会话引擎。
- `Task` 已有 `yunxiaoWorkitemId` / `yunxiaoSerialNumber` 字段，可回溯、可去重。

---

## What — 你的想法

点击**已导入的云效待办卡片**进入新的「议题详情页」（替换 `TodoTaskView`，非云效 todo 不变），
页面按三步走：

1. **看全貌（通过链接）**：页头附「在云效打开」链接，议题详情在云效查看，
   页面**不内联展示**议题内容；后台仍按 `workitemId` 查询详情，
   仅用于判定补充表单类型（Req/Bug）与给 AI 预填提供上下文。
2. **补内容**：按议题类型加载结构化补充表单，点「AI 预填」发起一次轻量 headless 调用，
   根据议题内容 + 类型模板生成草稿，逐字段人工调整后「定稿」。
3. **发起讨论**：定稿内容 + 云效链接 + 对应 Skill 流程指令组装为 prompt，
   走现有 `run_task` 链路启动真实 Agent 会话。

**类型 → 表单 / Skill 映射：**

| 云效类别 | 补充表单字段 | 讨论 Skill |
|----------|--------------|------------|
| Req（需求） | 标题 / 当前痛点 / 期望行为 / 备选方案 / 补充说明 | grilling |
| Task（任务） | 同上（复用需求表单） | 无（普通会话） |
| Bug（缺陷） | 标题 / 问题描述 / 期望行为 / 复现步骤 / 回归信息 / 补充说明 | diagnosing-bugs |

**数据落点：** 定稿内容写回本地任务 `prompt`（`tasks.json`，任务名保持「编号 + 标题」），
供讨论会话使用；讨论结果留在会话记录（SessionView 可回放 / 复制 / 导出）。
**不写回云效**（写回闭环放后续迭代单独评审）。

**核心交互（低保真）：**

```
┌─ Hsp 2.0 · 待办详情 ───────────────────────────────────────┐
│ ← 返回    QHDK-29728 任务列表加「只看 starred」筛选  [在云效打开 ↗] │
├────────────────────────────────────────────────────────────┤
│ 议题内容补充（需求）                    [AI 预填]           │
│ 标题        [任务列表加「只看 starred」筛选          ]      │
│ 当前痛点    [starred 一多就淹没在列表里，靠滚动找     ]      │
│ 期望行为    [侧边栏加 toggle，只显示 starred          ]      │
│ 备选方案    [按 star 排序而不是筛选                  ]      │
│ 补充说明    [                                        ]      │
│                                            [定稿]           │
├────────────────────────────────────────────────────────────┤
│ 讨论（grilling）                                           │
│ Agent：[Claude Code ▾] [Ask ▾]                  [发起讨论]   │
│ 定稿内容 + Skill 指令（Agent 记忆：下次默认上次选择）      │
└────────────────────────────────────────────────────────────┘
```

### 功能清单（v2）

1. **详情查询（内部用）**：新增后端命令按 `workitemId` 拉取议题详情，
   用于判定补充表单类型（Req/Bug）与 AI 预填上下文；页面**不内联展示**议题内容，
   通过「在云效打开」外部链接在云效查看详情（用户实测内联展示富文本/JSON 可读性差）。
2. **补充表单**：按类型渲染结构化字段表单（字段定义在代码中，v2 不做可配置）；
   「AI 预填」按钮触发轻量 headless 调用（复用 `agent_assist` 模式），
   返回结构化字段草稿，逐字段可编辑。
3. **定稿**：保存到本地任务 `prompt`（追加云效链接），持久化到 `tasks.json`。
4. **发起讨论**：后端维护「类型 → Skill 指令」映射，指令文本存后端常量；
   前端拼「完整议题 + 链接 + Skill 指令」作为 prompt，复用现有 `run_task` / 会话 / PTY 链路。
5. **路由分流**：云效 todo 卡片 → 新详情页；非云效 todo 卡片 → 原 `TodoTaskView` 不变。
6. **Agent 记忆**：「发起讨论」区提供 Agent 选择（Claude / Codex / DSH）；
   选定后按项目记忆（localStorage `nezha:lastYunxiaoAgent:<projectId>`），
   下次打开云效待办默认用上次选的；新导入议题也以记忆值为默认 agent
   （替换当前硬编码 claude）；无记忆时回退项目配置 `agent.default`。
7. **权限模式选择（YOLO）**：讨论区 Agent 选择旁提供权限模式选择
   （Ask → Auto-edit → YOLO，YOLO = `full_access`，即
   `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`），
   随发起讨论传入会话；默认沿用任务当前权限模式（导入时 `ask`）。

### 明确不做（v2 非目标）

- **不写回云效**：定稿 / 讨论结果不同步到云效议题（后续闭环迭代）。
- **不拉评论 / 附件**：详情页只展示基础字段。
- **不做云效列表项双入口**：详情页仅从待办卡片进入（列表项入口后续候选）。
- **不做自动 / 智能预填**：预填仅按钮触发。
- **不做表单模板可配置**：字段与 Skill 映射写死在代码中。
- **不做 Task 类 Skill 注入**：Task 走普通会话。

---

## Why — 动机和原因

**痛点场景：** 云效议题经常表述不完整（只有标题、描述残缺或含糊），
v1 只把列表字段导入成待办 prompt，点击待办看不到议题完整内容，也没有云效链接；
直接启动 Agent 会话时，Agent 拿到的上下文不完整，容易理解偏差、来回返工。

**期望行为：** 点击待办即看完整议题 + 链接；按固定格式把议题内容补全
（AI 预填 + 人工把关，解决「表述有问题」）；再用补全后的完整内容
按类型流程（需求走 grilling、Bug 走 diagnosing-bugs）发起讨论，
保证每次会话都从一份「完整、明确、格式统一」的议题出发。

**为什么优于其他备选：**

- 优于「只做详情页不做补全」：解决了「看」，没解决「表述不完整」——后者正是返工根因；
- 优于「直接全量 Agent 会话做补充」：重、贵、不可控，且容易把议题里的问题「脑补」掉；
  轻量 AI 预填 + 人工调整，成本和把关点都可控；
- 优于「无人工确认的自动补全」：AI 草稿可能存在幻觉，逐字段人工确认是质量闸门；
- 优于「讨论不按类型区分」：grilling / diagnosing-bugs 是两类议题各自的成熟流程，
  按类型注入指令后，讨论行为可复现、可测试，不依赖目标 Agent 本地是否装了 skill。

---

## Scope — 影响面

### 后端（Rust，`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `src-tauri/src/yunxiao.rs` | 新增 `yunxiao_get_workitem`（GetWorkitem 按 workitemId；域名白名单 + 超时 + 体积上限；token 不落日志） |
| `src-tauri/src/agent_assist.rs` | 新增 `generate_issue_supplement`（轻量 headless 调用：输入议题内容 + 类型模板 → 结构化字段输出，标签化解析；复用超时 / kill_on_drop / `project_path` 校验） |
| `src-tauri/src/agent_assist.rs`（或新常量模块） | 「类型 → Skill 指令」映射 + 指令文本常量（grilling / diagnosing-bugs 核心流程） |
| `src-tauri/src/lib.rs` | 注册新命令 |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `src/components/yunxiao/YunxiaoIssueDetailView.tsx`（新增） | 详情页：议题详情（只读）+ 补充表单（AI 预填 / 逐字段编辑 / 定稿）+ 发起讨论；组件 ≤400 行 |
| `src/components/yunxiao/issueForms.ts`（新增） | 表单字段定义（需求类 5 项 / Bug 6 项）+ 预填结果类型 |
| `src/components/ProjectPage.tsx` | 路由分流：云效 todo → 新详情视图；非云效 todo → `TodoTaskView` |
| `src/App.tsx` | `handleFinalizeYunxiaoSupplement`（更新 task.prompt + 追加链接 + 持久化）；`handleStartYunxiaoDiscussion`（拼 prompt = 定稿 + Skill 指令 → 复用 run_task） |
| `src/types.ts` | 新增 `YunxiaoWorkitemDetail` 等必要类型（不新增 Task 字段） |
| `src/utils/yunxiao.ts` | 新增 Agent 记忆读写（localStorage 按 projectId 隔离，`getLastYunxiaoAgent` / `setLastYunxiaoAgent`） |
| `src/styles/yunxiao.ts` | 详情页样式（不写 inline style，主题变量走 CSS 自定义属性） |
| `src/i18n.tsx` | en/zh 文案（AI 预填 / 定稿 / 发起讨论 / 在云效打开 / Agent 选择 / 字段标签等） |

> `handleImportYunxiaoIssue` 的 `agent: "claude"` 改为读取记忆值（无记忆时回退项目配置默认），
> 权限模式保持 `ask` 不变。

### 数据 / 迁移

- 不新增 `Task` 字段，无 schema 变更、无迁移脚本；
  「定稿」仅更新现有 `task.prompt`（持久化走现有 `save_project_tasks`）。
- Skill 指令文本与表单字段为代码常量，不入配置。

### 安全

- `yunxiao_get_workitem` 只接收 `token` / `organizationId` / `workitemId` 字符串，无路径参数；
  响应域名白名单校验，token 不进日志、不进错误信息。
- `generate_issue_supplement` 的 `project_path` 校验与 `generate_task_name` 同级
  （absolute + canonicalize + 是目录），作为 headless 进程 cwd。

### 不触及

- 终端性能红线：不改 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路。
- 不新增全局事件广播；详情/预填均按需 invoke。
- 不写回云效、不拉评论/附件、不引入虚拟滚动（详情页单条数据量可控）。

---

## 交互状态覆盖（PR 截图要求）

表单空态 / AI 预填后 / 人工编辑中 / 定稿后 /
发起讨论后 / 非云效 todo 不受影响（仍走 TodoTaskView）/
暗色 + 亮色主题各一张。

---

## 附录 A：Grill 会话已确认决策

1. **入口**：待办卡片直接进新详情页（云效议题）；非云效 todo 仍走 `TodoTaskView`。
2. **详情数据（内部用）**：按 `workitemId` 实时查询（GetWorkitem），
   仅用于表单类型判定与 AI 预填上下文；页面不内联展示议题内容，
   通过「在云效打开」链接在云效查看；评论/附件不做。
3. **补充机制**：轻量 AI 预填表单 + 人工逐字段调整定稿（复用 `agent_assist` headless 模式）。
4. **讨论机制**：定稿后「发起讨论」= 用完整议题启动真实 Agent 会话（复用 `run_task`）。
5. **Skill 注入**：后端维护「类型 → Skill 指令」映射，指令拼进会话 prompt；
   Req → grilling，Bug → diagnosing-bugs，Task → 无。
6. **表单字段**：需求类（Req/Task）= 标题/当前痛点/期望行为/备选方案/补充说明；
   Bug = 标题/问题描述/期望行为/复现步骤/回归信息/补充说明。
7. **落点**：定稿写回本地任务 prompt（追加云效链接）；讨论结果留会话可回放/导出；
   不写回云效。
8. **Task 类别**：复用需求表单，不注入 Skill。
9. **预填触发**：仅「AI 预填」按钮触发，不自动/不智能触发。
10. **链接**：详情页头「在云效打开」+ 定稿 prompt 追加云效链接。
11. **Agent 记忆**：选择器放详情页「发起讨论」区；按项目记忆上次选择
    （localStorage），新导入以此为默认；无记忆回退项目配置默认。
12. **权限模式选择**：讨论区支持选权限模式（Ask / Auto-edit / YOLO=full_access），
    随发起讨论传入会话，默认沿用任务当前权限。

## 附录 B：待评审 / 后续迭代候选

- **R1** 写回云效闭环：定稿 / 讨论结果同步更新云效议题描述或追加评论
  （需写权限 + 状态机映射，单独评审）。
- **R2** 评论 / 附件拉取：详情页信息更完整。
- **R3** 云效列表项双入口：列表行点击也进详情页。
- **R4** 智能预填触发：AI 判断字段缺失才自动预填。
- **R5** 表单模板可配置：字段与 Skill 映射下沉到配置文件。
- **R6** Task 类 Skill 注入（如也用 grilling）。

## 附录 C：验证清单（开发完成时）

- [ ] `cargo check` / `pnpm build`（tsc）/ `pnpm test` 通过
- [ ] 真实 token 复验 `GetWorkitem` 路径与返回字段
- [ ] 详情页：查询成功展示完整字段；失败回退本地 prompt；「在云效打开」链接正确
- [ ] 预填：轻量 AI 返回结构化字段草稿；失败时可手动填写；超时/失败有可读提示
- [ ] 定稿：任务 prompt 更新为完整议题（含云效链接）；`tasks.json` 持久化正确
- [ ] 发起讨论：prompt 包含完整议题 + 对应 Skill 指令；Req→grilling / Bug→diagnosing-bugs / Task→无
- [ ] 路由分流：云效 todo → 详情页；非云效 todo → `TodoTaskView` 不变
- [ ] Agent 记忆：详情页选择后按项目持久化；切换项目隔离；新导入议题默认使用记忆值；
  无记忆时回退项目配置默认（claude）
- [ ] 暗色/亮色主题截图齐全；加载/空/错误态覆盖
