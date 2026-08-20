# 需求：云效议题识图 + 修改方案回写闭环（V3）

> 状态：**已与需求方 grill 确认，进入开发**（分支 `云效V3迭代` 直接实现，先做出来再按试用反馈调整）。
> 承接：`yunxiao-issues-integration-v1.md`（列表/导入）、`yunxiao-filters-v2.md`（过滤）、
> `yunxiao-issue-detail-v2.md`（详情/补全/讨论，其附录 R1「写回闭环」与 R2「评论/附件」即本迭代起点）。

---

## 背景事实（代码查证 + 官方文档）

- 云效 token / organizationId / projectId 存于 `~/.nezha/settings.json`（`YunxiaoSettings`），
  后端 `yunxiao.rs` 全部为只读命令，鉴权头 `x-yunxiao-token`。
- 议题描述解析（`normalize_issue_description`）只抽文本，图片（HTML `<img>` / 富文本图片节点）被直接丢弃。
- 已有附件管道：`run_task` 图片 → `.nezha/attachments/<taskId>/` → prompt 末尾 `[Attached images]` → 完成自动清理。
- 提交链路：`git_commit` 裸 `git commit -m`；`merge_task_worktree` 无提交信息校验；无任何 `#QHDK-xxxxx` 强制。
- 云效官方接口（help.aliyun.com，已确认）：
  `CreateWorkitemComment`：`POST /oapi/v1/projex/organizations/{organizationId}/workitems/{id}/comments`，
  头 `x-yunxiao-token`，body `{"content": "..."}`，返回 `{"id": "..."}`；权限「工作项评论 读写」。

## What

### 1. 议题识图

- 发起讨论时（`handleStartYunxiaoDiscussion`）：
  1. `GetWorkitem` 拉全量描述；
  2. 提取图片 URL（HTML `<img src>`、富文本 JSON 图片节点、Markdown `![alt](url)`，去重）；
  3. 后端带 token 下载到 `.nezha/attachments/<taskId>/`（复用附件生命周期）；
  4. 路径拼进 prompt（`[Attached images]`），Agent 用自身视觉读原图。
- 边界：单张 ≤10MB、最多 20 张；域名白名单（`*.aliyuncs.com` / `*.alicdn.com` / `*.aliyun.com`）；
  Content-Type 必须 `image/*`（仅 png/jpg/gif/webp/bmp）；文件名「序号 + 扩展名」。
- 失败策略：部分失败跳过并提示数量；全部失败阻断发起并允许重试。
- UI：详情页讨论区一行状态提示（「议题含 N 张图片，发起讨论时自动下载」）；不内联预览。
- 重跑：不持久化图片 URL；恢复/重跑云效任务时提示「图片可能已随任务清理，可重新发起或手动补图」。

### 2. 修改方案回写闭环

- 入口：任务 `done` 且为云效导入（`yunxiaoWorkitemId`）时，RunningView 顶部显示「回写云效」按钮；
  任务列表卡片显示「待回写」徽标（未回写时）。
- 流程：点按钮 → 生成「修改方案汇总」预览（可编辑）→ 确认 → `CreateWorkitemComment` 追加评论。
- 汇总内容：事实骨架（议题编号/标题、定稿补充字段、关联 commit 短哈希+提交信息、变更统计）
  + headless Agent 润色一段方案汇总；AI 失败回退纯事实模板。
- 幂等：Task 新增 `yunxiaoWrittenBackAt` / `yunxiaoCommentId`；成功后按钮置「已回写」。

### 3. 提交关联议题编号

- 讨论 prompt 追加指令：提交信息必须包含 `#<议题编号>`（如 `#QHDK-29312`）。
- `git_commit`：可选 `issueTag`，消息缺 tag 时自动追加。
- `merge_task_worktree`：可选 `expectedIssueTag`，合并前校验 `base..branch` 全部提交含 tag，缺失阻断并列出违规提交。

## Why

- 识图：议题中的截图（Bug 复现、UI 稿）是 Agent 完成任务的关键上下文，当前解析直接丢图，Agent 拿不到。
- 回写：v2 明确把「方案回写云效」延后，导致处理结果只在本地会话里，议题上没有结论、无法闭环。
- 提交关联：云效按提交信息中的 `#编号` 自动关联代码，缺 tag 则议题与代码失联。

## Scope

- 后端：`yunxiao.rs`（图片提取/下载 + 评论回写）、`agent_assist.rs`（回写汇总生成）、
  `git.rs`（`git_commit` 补 tag + `merge_task_worktree` 校验）、`storage.rs`（Task 两字段）、`lib.rs`（注册命令）。
- 前端：`App.tsx`（发起讨论下载图片、回写状态）、`ProjectPage.tsx`（回写弹窗/透传）、
  `RunningView.tsx`（回写按钮）、`TaskListItem.tsx`（待回写徽标）、`GitChanges.tsx`（issueTag 注入）、
  `types.ts` / `utils/yunxiao.ts` / `styles/yunxiao.ts` / `i18n.tsx`。
- 不触及终端性能红线；不新增全局事件广播；图片/评论均按需 invoke。

## 验证

- `cargo check` / `cargo test`、`pnpm build` / `pnpm test` 通过。
- 真实 token 复验：图片 URL 格式与下载鉴权、`CreateWorkitemComment` 返回结构。
- UI 状态覆盖：待回写 / 已回写 / 生成中 / 生成失败 / 发布失败；暗色+亮色截图。
