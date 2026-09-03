# 需求：云效议题集成 —— 查看议题、导入待办任务、看板待办列启动会话

> 状态：**需求文档（待评审）**——先评审方向，再进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha
> 对应功能：Nezha 桌面端新增「云效议题」全屏视图；议题可一键导入为本地待办任务；
> 任务看板新增「待办」列；从待办任务直接启动 Agent 会话。

---

## 背景事实（已通过 API 实测确认）

- 云效组织：`641881e9b9581d62e8f8186e`（云南达远软件有限公司）
- 云效项目：`07a763450c8733172523320ab6`（Hsp 2.0），即用户提供的
  `https://devops.aliyun.com/projex/project/07a763450c8733172523320ab6`
- 官方接口（中心版）：
  - 服务接入点：`https://openapi-rdc.aliyuncs.com`
  - 鉴权：请求头 `x-yunxiao-token: <个人访问令牌>`
  - 组织列表：`GET /oapi/v1/platform/organizations`
  - 项目搜索：`POST /oapi/v1/projex/organizations/{orgId}/projects:search`
  - 工作项搜索：`POST /oapi/v1/projex/organizations/{orgId}/workitems:search`
    - body：`category`（Req/Task/Bug，多值逗号分隔）、`conditions`（JSON 字符串过滤）、
      `spaceId`（项目 id）、`spaceType`（Project）、`orderBy`、`sort`、`page`、`perPage`
    - 分页总量在响应头 `x-total`
  - 实测返回的工作项字段：`serialNumber`（如 QHDK-29728）、`subject`、`description`、
    `status`、`assignedTo`、`creator`、`gmtCreate`、`customFieldValues`（含优先级 `priority`）、
    `categoryId`、`workitemType`、`logicalStatus`
- 云效官方文档明确要求：个人访问令牌**不得硬编码进代码、不得提交仓库**，应按本地配置管理。

---

## What — 你的想法

在 Nezha 中增加一个**全屏视图「云效议题」**，浏览云效 Projex 项目的工作项（需求/任务/缺陷），
选中议题一键导入为本地**待办任务**；任务看板新增**待办列**，用户可在待办任务上直接启动 Agent 会话。

**核心交互（低保真）：**

```
┌─ 欢迎页侧边栏 ───────────┐  ┌─ 云效议题（全屏视图）────────────────────────┐
│ 项目                      │  │  ← 返回   云效议题    [刷新] [重新连接]        │
│ 时间线                    │  │  Hsp 2.0 · 云南达远软件有限公司               │
│ 技能                      │  │  ┌─────────────┬──────────┬──────────┐       │
│ 云效议题 ◀ 进入           │  │  │ 全部 │ 需求 │ 任务 │ 缺陷 │ 🔍搜索   │       │
└──────────────────────────┘  │  ├────────────────────────────────────────┤  │
                              │  │ QHDK-29728 【芒市医共体】试剂出库查询…   │  │
                              │  │   待处理 · 高 · 许宏民 · 2026-08-18       │  │
                              │  │                             [导入]        │  │
                              │  │ QHDK-29727 医保主表合同单位回写不匹配…    │  │
                              │  │   待处理 · 高 · 宋源波 · 2026-08-18       │  │
                              │  │                             [已导入]       │  │
                              │  │ …（分页：加载更多）                       │  │
                              │  └────────────────────────────────────────┘  │
                              └──────────────────────────────────────────────┘
                                             │ 点「导入」
                                             ▼
                              ┌─ 导入到本地项目（记住上次选择）─────────────┐
                              │ 目标项目：[Hsp 2.0（本地仓库）▾]  [导入]     │
                              └─────────────────────────────────────────────┘
                                             ▼
                              ┌─ 任务看板（新增「待办」列）─────────────────┐
                              │ 待办        │ 进行中  │ 需要介入 │ 待确认   │
                              │ QHDK-29728 │ …       │ …       │ …        │
                              │ QHDK-29727 │         │         │          │
                              └────────────────────────────────────────────┘
                                             ▼ 点待办卡片
                              ┌─ 待办任务详情（TodoTaskView）───────────────┐
                              │ 提示词 + 议题上下文          [启动会话] ▶    │
                              └─────────────────────────────────────────────┘
```

### 功能清单（v1）

1. **全屏视图「云效议题」**：入口在欢迎页侧边栏（与项目/时间线/技能同级）。
2. **连接配置**：首次使用需填写个人访问令牌 → 自动拉取组织列表 → 拉取项目列表 →
   选择组织 + 项目后保存。配置存应用级设置 `~/.nezha/settings.json`（新增 `yunxiao` 段），
   不在代码中硬编码。
3. **议题浏览**：按类别 Tab（全部=需求+任务+缺陷 / 需求 Req / 任务 Task / 缺陷 Bug）
   与本地搜索（标题/编号）过滤；分页加载（每页 100，`加载更多`）；手动刷新。
4. **导入为待办任务**：每条议题有「导入」按钮；导入时选择目标本地项目
   （默认记住上次选择）；生成 `status: todo` 的任务，任务名 = 议题编号 + 标题，
   提示词 = 议题标题 + 描述 + 优先级/负责人/状态等上下文；同一议题**去重**（仅导入一次，
   已导入的显示「已导入」并禁用按钮）。
5. **看板待办列**：`KanbanView` 新增「待办」列（`status === "todo"` 的任务），
   与进行中/需要介入/已完成待确认并排；点卡片进入该任务详情，可启动会话。
6. **启动会话**：复用现有待办运行链路（`handleRunTodoTask` → `run_task`），零改动。

### 明确不做（v1 非目标）

- **不写回云效**：不在任务完成/取消时更新云效工作项状态（v2 候选）。
- **不做议题详情页**：v1 只展示列表字段；点击外部链接在浏览器打开（候选）。
- **不做自动轮询**：v1 手动刷新（候选：定时轮询 + 角标）。
- **不做服务端复杂过滤**：v1 用本地搜索 + 类别 Tab；服务端 `conditions` 过滤（状态/负责人等）留 v2。

---

## Why — 动机和原因

**痛点场景：** 团队在云效 Projex 维护需求/缺陷（Hsp 2.0 项目，编号 QHDK-xxxxx），
但实际开发由 Nezha 里的 AI Agent 完成。当前流程是：云效看议题 → 在 Nezha 手动新建任务 →
把议题标题、描述、优先级等**手工复制粘贴**成提示词 → 再启动会话。手工搬运易漏字段、
无法追溯「这个任务来自哪个议题」，任务多时看板里也分不清哪些是待办。

**期望行为：** 在 Nezha 里直接看云效议题 → 点一下导入成待办任务（自动携带完整上下文）→
看板「待办」列统一管理 → 点卡片启动 Agent 会话。云效是唯一数据源，Nezha 任务带
`yunxiaoWorkitemId` 可回溯、可去重。

**为什么优于其他备选：**

- 优于「只做一个云效网页跳转/嵌入」：不解决「议题 → 任务 → 会话」的闭环，用户仍要手工搬运；
- 优于「把议题直接当任务跑（不落 todo）」：议题默认是「待办」，应先进待办列由用户挑选后
  再启动，直接跑会丢失人工把关；
- 优于「反向同步（Nezha 任务完成 → 云效议题流转）」：v1 只做读侧集成，改动面小、风险低，
  写回涉及的权限/状态机/自动化规则留 v2 单独评审；
- 优于「右侧面板」（原推荐，被用户否决）：全屏视图信息密度高、承载配置+浏览+导入完整流程，
  不被任务面板挤压。

---

## Scope — 影响面

### 后端（Rust，`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `src-tauri/src/yunxiao.rs`（新增） | 云效 OpenAPI 客户端：`yunxiao_list_organizations` / `yunxiao_search_projects` / `yunxiao_search_workitems`。用 `reqwest`（已在依赖中）异步请求，请求头 `x-yunxiao-token`，响应域名校验 + 超时 + 体积上限 |
| `src-tauri/src/app_settings.rs` | `AppSettings` 新增 `yunxiao: YunxiaoSettings`（token / organizationId / organizationName / projectId / projectName），随 `settings.json` 存取；新增 `save_yunxiao_settings` 命令（`spawn_blocking`） |
| `src-tauri/src/storage.rs` | `Task` 结构体同步新增 `yunxiaoWorkitemId` / `yunxiaoSerialNumber`（可选字段，`skip_serializing_if`，向后兼容旧数据） |
| `src-tauri/src/lib.rs` | 注册 `mod yunxiao` + 3 个新命令 + `save_yunxiao_settings` |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `src/types.ts` | `Task` 新增 `yunxiaoWorkitemId?` / `yunxiaoSerialNumber?`；新增 `YunxiaoOrganization` / `YunxiaoProject` / `YunxiaoWorkitem` / `YunxiaoPage<T>` 类型 |
| `src/components/app-settings/types.ts` | `AppSettings` 新增 `yunxiao` 段 + `EMPTY_YUNXIAO_SETTINGS` |
| `src/components/YunxiaoView.tsx`（新增） | 全屏视图：连接配置（token→组织→项目）、类别 Tab、本地搜索、分页列表、导入待办（含目标项目选择 + 记忆上次选择） |
| `src/components/WelcomePage.tsx` | 侧边栏新增「云效议题」入口（`view === "yunxiao"`），透传 `projects / tasks / onImportYunxiaoIssue` |
| `src/App.tsx` | 新增 `handleImportYunxiaoIssue`：校验去重 → 创建 `status: todo` 任务（agent=claude / permission=ask 与 NewTaskView 默认一致）→ `persistProjectTasks` |
| `src/components/KanbanView.tsx` | 新增「待办」列（`ColumnKey = "todo"`，纳入 `COLUMN_ORDER`），卡片点击复用现有 `onTaskClick` |
| `src/styles/` | 新增 `yunxiao.ts` 样式模块（不写 inline style）；kanban 增加待办列圆点/列样式 |
| `src/i18n.tsx` | en/zh 新增云效视图与「kanban.column.todo」文案 |

### 数据模型 / 迁移

- `Task` 新增两个可选字段（`types.ts` + `storage.rs` 同步，遵守 AGENTS.md schema 规则）；
  旧任务文件无此字段，`serde(default)` 兼容，**无迁移脚本**。
- `AppSettings` 新增 `yunxiao` 段，缺省为空对象，旧 `settings.json` 兼容。
- 目标项目记忆存 `localStorage`（`nezha:yunxiaoLastProjectId`），非持久化核心数据。

### 安全

- token 仅写入 `~/.nezha/settings.json`（本地用户目录）；不打印日志、不进错误信息、不提交仓库。
- 后端对所有云效响应做域名白名单校验（`openapi-rdc.aliyuncs.com`）。
- 云效 API 命令不接收任意 URL/路径参数，无目录遍历面。

### 不触及

- 终端性能红线：不改 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路。
- 不新增全局事件广播（议题数据按需 invoke 拉取，不进事件总线）。
- 长列表：议题列表按页加载（每页 ≤100），单页 DOM 量可控；若后续单页超千条再上虚拟滚动。

---

## 交互状态覆盖（PR 截图要求）

默认 / hover / 聚焦 / 加载中 / 空态（无议题）/ 错误态（token 无效、网络失败）/
未连接态（首次配置表单）/ 已导入态（去重禁用）/ 暗色 + 亮色主题各一张。

---

## 附录 A：Grill 会话已确认决策

1. **视图形态**：全屏视图（用户明确选择），入口在欢迎页侧边栏。
2. **导入目标项目**：导入时由用户选择本地项目，并记住上次选择
   （`localStorage`）；不强制设置里维护固定映射。
3. **连接配置**：存应用级设置 `settings.json`（v1 明文本地存储；
   OS keychain 加密存储列为 v2 候选）。
4. **同步方向**：云效 → Nezha 单向（议题导入为待办任务）；Nezha → 云效写回不在 v1。
5. **议题范围**：全部类别（Req/Task/Bug）默认展示，Tab 切换；本地搜索；分页加载；
   手动刷新（自动轮询 v2）。
6. **去重**：以 `yunxiaoWorkitemId` 为键，同议题只导入一次；导入后按钮变「已导入」禁用。
7. **看板待办列**：`KanbanView` 增加 `todo` 列，卡片点击进入任务详情（TodoTaskView）启动会话。
8. **工程约束**：新组件下沉独立目录、样式进 `styles/`、文案进 i18n、不写 inline style、
   组件 ≤400 行；`Task` schema 双端同步；Rust 新命令注册进 `lib.rs` 并遵守
   `spawn_blocking`/锁作用域规范。

## 附录 B：待评审/后续迭代候选

- **R1** 任务完成/取消时写回云效工作项状态（需云效写权限 + 状态机映射表，单独评审）。
- **R2** 定时轮询云效 + 导入数角标；新议题高亮。
- **R3** 服务端过滤（状态/负责人/迭代）下拉，替代本地搜索。
- **R4** token 改用系统 keychain（`keyring` crate），settings.json 只存非敏感项。
- **R5** 议题外部链接（打开浏览器跳云效详情页）。
- **R6** 项目页内入口（ProjectRail/头部按钮）直达云效视图。
- **R7** 评估官方「云效 MCP Server」作为替代通道（若后续 Nezha 引入 MCP 客户端再对比）。

## 附录 C：验证清单（开发完成时）

- [ ] `cargo check` / `pnpm build`（tsc）通过
- [ ] 真实 token 拉取组织/项目/议题成功；错误 token 显示可读错误
- [ ] 导入去重：同议题第二次导入被拦截
- [ ] 看板待办列显示/排序/点击跳转正确；暗色亮色主题正常
- [ ] token 不出现在日志与错误提示中
