# 提案：行级 Review 评论，一键批量发送给对应 Agent

> 状态：**已实现（v1）**——以 maintainer 口头批复（issue-first 流程豁免）直接落地。
> 对应 issue 标题：`feat(file-viewer): 行级 Review 评论，一键批量发送给对应 Agent`
> 仓库：https://github.com/Alohazzz/nezha

---

## What — 你的想法

在 **FileViewer（代码编辑器）** 中增加行级评论功能，并支持把评论**批量发送给正在运行的 Agent（Claude Code / Codex）**，形成「Review 提意见 → Agent 快速响应修改」的闭环。

**核心交互（低保真）：**

```
┌─ FileViewer 编辑器 ────────────────────────────┐
│  12│ const editorBaseTheme = EditorView.theme({ │
│  13│   "&": {                                   │
│  14│     height: "100%",                        │
│  15│     background: "var(--bg-panel)",         │
│     └─── 选中 12-15 行 → 浮出气泡「＋评论」     │
│  （或不选中，直接点 gutter 单行）               │
└────────────────────────────────────────────────┘
            ▼ 填写正文（自动识别 src/foo.ts:12-15 + 代码片段）
┌─ FileViewer 底部评论抽屉（可折叠，徽标「3」）───┐
│ ☑ @src/foo.ts:12-15  片段…  意见一   [发送][✓] │
│ ☑ @src/bar.ts:33      片段…  意见二   [发送][✓] │
│                        [发送选中的 N 条 → Agent] │
└────────────────────────────────────────────────┘
```

- **创建入口（三选一）**：① 选中文字 → 浮气泡「＋评论」；② 右键菜单「添加评论」；③ 点 gutter 单行加评论。自动识别**相对路径 + 行号范围 + 选中文本片段**。
- **评论记录**：`path / startLine / endLine / snippet / 正文 / open|resolved / 锚定任务 id / 时间`。**不持久化**——纯项目会话级内存态（切面板/切文件不丢，切项目清空，重启丢失），是 Review 时和 Agent 沟通的临时产物。
- **评论列表**：FileViewer 底部可折叠抽屉；点条目跳转对应行；可标记已解决；可编辑/删除。
- **发送**：勾选多条（默认只勾未发送的）合并成**一条消息**发送；每条旁也有单条发送兜底。消息格式即点即发、不可预览编辑：

```
@src/components/FileViewer.tsx:88-101
```ts
const editorBaseTheme = EditorView.theme({ ... });
```
> 这段主题里 .cm-scroller 的 overflow:auto 与 .cm-content 的 padding 组合，
> 在窄面板下会出现横向滚动条，建议改成 overflow-x:hidden 或加 min-width 约束
```

- **目标 Agent 判定（自动）**：`awaiting_review` → `input_required` → `running` → 最近活跃。任务已死 → 明示两个选项「恢复会话再发（resume_task）/ 作为新任务发（run_task，自动附原任务 prompt）」。任务 running 中发送需确认打断。

## Why — 动机和原因

**痛点场景：** 当前 Agent 完成任务进入 `awaiting_review` 状态后（该状态已在 `event_watcher.rs` 实现），用户唯一能反馈的通道是**终端里手动打字**。Review 时发现问题要先记在别处（脑记/外部笔记），再逐条手打进终端、手动拼 `@路径:行号` 引用和代码片段——**反馈链路长、易漏、AI 定位成本高**。

**期望行为：** 边看代码边圈选打标，攒几条后一键批量发给 Agent，消息自动带 `@路径:行号` + 代码片段（Claude Code / Codex 原生支持的引用语法），AI 无需重新读文件即可定位响应——这正是「AI 快速响应」的关键。

**为什么优于其他备选：**
- 优于「文件树挂评论」（文件级）：行级定位让 AI 响应速度与准确度直接提升，且完全贴合现有 `awaiting_review` 交互循环；
- 优于「GitChanges diff 挂评论」：v1 不绑定 git diff 子系统，改动面小、不依赖 diff 解析，行级定位在 diff 视图下同样可用（v2 可再扩展 hunk 锚点）；
- 优于「自动回填 AI 回复到评论 thread」：v2 再做，v1 闭环 = 发送 → 切终端看响应 → 手动标记已解决（避免会话解析的脆弱性拖慢主功能）。

## Scope — 影响面

**纯前端改动，零后端命令新增：**

| 模块 | 改动 |
|------|------|
| `src/components/FileViewer.tsx` | 选区浮气泡、右键菜单项、gutter 单击、评论抽屉挂载点 |
| `src/components/file-viewer/`（子目录） | 新增 `CommentComposer` / `CommentList` / `CommentDrawer` 等子组件（守 400 行/组件红线） |
| `src/components/ProjectPage.tsx` | 评论 state 提升至此（跨面板存活），向 FileViewer 传 props |
| `src/i18n.tsx` | 新增评论相关文案 |
| `src/styles/` | 新增评论样式模块（不写 inline style） |

**复用现有能力（不新增 Tauri 命令）：**
- `send_input`（`pty.rs:1405`）——直投 PTY，等同替用户打字；
- `resume_task` / `run_task`——任务已死时的「恢复会话 / 新建」两条路；
- `task-status` 事件（含 `awaiting_review`）——目标任务判定依据；
- `get_active_task_ids`——活跃任务枚举。

**不触及终端性能红线：** 不改 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路；不新增事件广播（发送仍走既有 `send_input` 通道）。

**数据模型：** 评论**不持久化**、不改 `types.ts` 的 `Task`、不动 `storage.rs`——**无迁移、无 schema 变更**。

**交互草图与状态覆盖**（PR 时会补齐）：默认 / hover / 选中 / 空态（无评论）/ 已发送 / 已解决 / 暗色 + 亮色主题各一。

---

## 附录：Grill 会话完整决策记录（v1 实现依据）

### 已确认决策
1. **锚点**：行级评论，选中内容自动识别文件 + 行号范围
2. **入口**：选中浮气泡「＋评论」+ 右键菜单项 + gutter 单击单行
3. **记录内容**：`path / startLine / endLine / snippet / text / status(open|resolved) / taskId(锚定) / createdAt`
4. **锚定任务**：默认锚定创建时的当前活跃任务；发送时可换 agent/新建并自动带上下文
5. **回复闭环**：v1 = 发过去 → 终端看响应 → 手动标记 resolved；自动回填 v2
6. **不持久化**：纯前端项目会话级内存态，切面板/切文件不丢，切项目清空，重启丢失；不进 storage.rs
7. **消息格式**：即点即发，「正文 + 定位头（@路径:行号 + 代码片段）」自动组装，不预览编辑
8. **批量发送**：勾选多条合并成一条消息（多组 @定位 + 片段 + 正文），每条评论旁保留单条发送兜底；批量默认只勾选未发送的
9. **目标任务判定**：awaiting_review → input_required → running → 最近活跃；任务已死 → 明示「恢复会话再发 / 作为新任务发」；任务 running 中 → 打断需确认
10. **评论列表 UI**：FileViewer 底部可折叠抽屉，徽标计数，点条目跳转行，勾选 + 发送按钮都在这里

### 推荐分支（后续迭代可调）
- **R1 创建细节**：选中 0 行 → gutter 单击单行；多行上限 50 行 / snippet 2000 字符截断（超长截断并在消息里注明）；二进制/图片/超 2MB 文件不可评论
- **R2 编辑删除**：评论列表内可改正文、可删除（临时产物无历史）
- **R3 发送归属**：发送对话框默认目标 = 当前活跃任务，可下拉改选任意任务；勾选评论统一发到所选目标任务
- **R4 文件改动后行号漂移**：v1 不处理（临时产物 + 消息自带 snippet 兜底），v2 再考虑按 snippet 重锚定
- **R5 双 agent 语法**：Claude Code 用 `@path:行号` 原生引用；实现时验证 Codex 是否支持，不支持则退化为「相对路径 + 行号 + 代码片段」纯文本格式
- **R6 工程约束**：新字符串进 i18n、样式进 `styles/`、组件下沉 `file-viewer/` 子目录、不写 inline style、不超 400 行/组件；评论 state 提升到 ProjectPage 级（跨面板存活）
- **R7 流程**：issue-first——先开提案 issue 等 maintainer `accepted` 再动手
