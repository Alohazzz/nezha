# 需求：系统通知 —— Agent 需要确认 / 任务完成时提醒（v1）

> 状态：**需求文档（待评审）**——grilling 决策树已走完，进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha

---

## 背景事实

- 当前**不支持系统通知**：`notification.rs` 是远程公告拉取（应用内铃铛，`nezha.hanshutx.com/notifications.json`），
  与 OS 通知无关；依赖无 `tauri-plugin-notification`，注册插件仅 single-instance / opener / dialog；
  前端也无 Web Notification 调用。
- 应用已有精确的 attention 状态机，可直接作为触发源：
  - `input_required`（Claude permission_prompt / elicitation_dialog、Codex PermissionRequest）→ 需要确认；
  - `awaiting_review`（Agent Stop，本轮完成待验收）→ 需要确认；
  - `done` / `failed` / `cancelled`（PTY 退出终态）；
  - 前端已有 `attentionRequestedAt` + 可开关的「待确认角标」（纯应用内 UI），
    后端 `emit_active_status` 对同任务同状态有去重。
- 后端状态发出点只有 `task_id`，无任务名；前端 `run_task` / `resume_task` 调用未传任务名
  （但前端持有 `task.name`，可传入后端在 TaskManager 内存记录）。

---

## What — 你的想法

新增 **OS 级系统通知**（Windows toast / macOS 通知中心 / Linux 通知），在 Agent
需要用户确认、任务完成或失败时提醒，配合现有应用内角标，覆盖"用户切走/最小化窗口"场景。

### 功能清单（v1）

1. **触发事件**：`input_required` / `awaiting_review` →「需要确认」；
   `done` →「已完成」；`failed` →「执行失败」并附失败原因；`cancelled` 不通知。
2. **窗口条件**：仅当应用窗口未聚焦（含最小化/隐藏）时发送；窗口聚焦时只更新应用内角标。
3. **去重**：按「任务 × 通知类别」60 秒冷却，避免 ask 模式审批循环刷屏；
   冷却过后再触发仍会发送（保证隔半小时后的终态不丢）。
4. **载体**：后端 Rust + 官方 `tauri-plugin-notification`，跨平台原生通知；
   点击通知聚焦并唤起应用窗口（v1 不做跳转任务）。
5. **设置**：「系统通知」总开关，默认开启，持久化到 `~/.nezha/settings.json`（后端可读）。
6. **文案**：中文，标题「Nezha」，正文含任务名 + 状态
   （如「任务《QHDK-29749 …》需要你的确认」）；任务名由前端在
   `run_task` / `resume_task` 时传入，TaskManager 内存记录。

### 明确不做（v1 非目标）

- **不做点击跳转任务**：点击通知只聚焦窗口（跳转放后续候选）。
- **不做细分开关**：只有总开关，不分「需要确认 / 完成失败」。
- **不做通知历史/持久化**：通知即发即弃，不落盘。
- **不改远程公告**：`notification.rs`（铃铛）保持现状。
- **不改任务状态机语义**：仅挂触发点，不改变现有 `task-status` 流程。

---

## Why — 动机和原因

**痛点场景：** Agent 在后台执行时，用户经常切到别的窗口或最小化 Nezha。此时 Agent
需要审批、提问或任务完成/失败，用户没有任何感知——ask 模式的审批可能一直挂着，
任务失败也要等切回应用才能看到。

**期望行为：** 切走/最小化时，Agent 需要确认或任务有终态（成功/失败）立即弹系统通知；
回到应用窗口时只依赖角标，不打扰。

**为什么优于其他备选：**

- 优于「只做应用内角标」：角标只在应用内可见，切走后无法感知；
- 优于「前端 Web Notification」：WebView2 支持不可靠，官方插件是 Tauri 原生路径；
- 优于「无条件每次弹」：聚焦时弹通知会打断正在进行的审批操作；
- 优于「无冷却」：ask 模式审批循环会刷屏；按任务×类别 60s 冷却兼顾及时性与克制；
- 优于「不带任务名」：用户需要知道"哪个任务"需要处理。

---

## Scope — 影响面

### 后端（`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `Cargo.toml` | 新增 `tauri-plugin-notification = "2"` |
| `capabilities/default.json` | 新增 notification 权限 |
| `lib.rs` | 注册通知插件；`TaskManager` 新增任务名内存表；`run_task` / `resume_task` 接收 `task_name` |
| `system_notify.rs`（新增） | 发送 + 窗口聚焦判断 + 60s 冷却 + 设置读取 + 点击聚焦窗口 |
| `event_watcher.rs` | `emit_active_status` 在 `input_required` / `awaiting_review` 时触发通知 |
| `pty.rs` | `finalize_task_exit` 在 `done` / `failed` 时触发通知（failed 附失败原因） |
| `app_settings.rs` | `AppSettings` 新增 `system_notifications: bool`（`serde(default)` 兼容旧数据） |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `App.tsx` | `invokeRunTask` / `invokeResumeTask` 传 `taskName` |
| `app-settings/types.ts` | `AppSettings` 新增 `systemNotifications?: boolean`（默认 true） |
| `components/AppSettingsDialog.tsx` | 「系统通知」开关（与「待确认角标」并列） |
| `i18n.tsx` | zh/en 文案 |

### 数据 / 迁移

- `AppSettings` 新增可选字段，旧 `settings.json` 无字段，`serde(default)` 兼容，无迁移脚本。

### 安全 / 不触及

- 通知发送失败静默（不阻塞任务流程）；通知内容来自本地任务名，无外部输入。
- 不触及终端性能红线；不改 `notification.rs` 远程公告、不改任务状态机语义。

---

## 交互状态覆盖（PR 截图要求）

应用设置对话框「系统通知」开关（开/关、暗/亮主题各一张）；
系统 toast 为 OS 层行为，以实际运行验证为准（截图无法覆盖时在 PR 说明）。

---

## 附录 A：Grill 会话已确认决策

1. **触发事件**：`input_required` / `awaiting_review` / `done` / `failed` 通知；`cancelled` 不通知。
2. **窗口条件**：仅窗口未聚焦/最小化/隐藏时发送；聚焦只更新应用内角标。
3. **去重**：任务 × 类别 60 秒冷却。
4. **载体**：后端 Rust + `tauri-plugin-notification`。
5. **点击**：v1 只聚焦唤起窗口，不跳转任务。
6. **设置**：单一「系统通知」总开关，默认开启，持久化 `settings.json`。
7. **文案**：中文，任务名 + 状态；failed 附失败原因。
8. **任务名来源**：前端 `run_task` / `resume_task` 传 `task_name`，TaskManager 内存记录。
9. **流程**：issue-first——先提案 issue，批复后实现；PR 附设置开关截图。

## 附录 B：待评审 / 后续迭代候选

- **R1** 点击通知跳转对应任务（打开项目 + 选中任务）。
- **R2** 细分开关（需要确认 / 完成失败）。
- **R3** 通知文案双语（en）。
- **R4** 通知声音/样式配置。

## 附录 C：验证清单（开发完成时）

- [ ] `cargo check` / `cargo test` / `pnpm build` / `pnpm lint` / `pnpm test` 通过
- [ ] 窗口聚焦时不发通知；最小化/切走后 `input_required` / `awaiting_review` / `done` / `failed` 各发一条
- [ ] 60s 冷却：同任务同类别重复触发不重复弹；冷却后恢复
- [ ] 失败通知正文含失败原因；`cancelled` 不弹
- [ ] 设置开关关闭后不再弹；重启应用保持关闭
- [ ] 点击通知唤起窗口
- [ ] 旧 `settings.json` 无新字段时正常读取（默认开启）
