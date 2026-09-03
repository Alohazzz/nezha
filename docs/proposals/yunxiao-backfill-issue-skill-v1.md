# 需求：云效「补录议题」——Skill 驱动的讨论中发现即建议题 + 自动待办（v1）

> 状态：**需求文档（待评审）**——先评审方向，再进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha
> 承接：`yunxiao-issues-integration-v1.md`（正向导入）、`yunxiao-v3-close-loop-and-images.md`（回写闭环）、
> `yunxiao-draft-persistence-v4.md`（草稿落盘）。本提案补齐**反向**场景：讨论/执行中发现新问题 → 补录议题并自动关联。

---

## 背景事实（代码 + 云效官方文档查证）

- 云效工具链已存在：`yunxiao.rs`（OpenAPI 客户端，`CreateWorkitem` 已可建需求/评论）、
  `drafts.rs`（`discussion.md`/`knowledge.json` 落盘 + 收拢）、`event_watcher.rs`（events.jsonl 近实时事件回传）、
  `skills.rs`（SkillHub 仓库安装/解析/运行，`NEZHA_SKILL_DATA_DIR` 等 env 注入）。
- 云效基础字段：`CreateWorkitem` body 需 `spaceId` + `assignedTo`（当前用户 id）+ `workitemTypeId`；category=Req/Bug；描述为富文本 body。
- 云效模板（Hsp 2.0 实测）：
  - **缺陷**：缺陷描述 / 发生频率 / 影响范围 / 业务影响 + 基础字段（负责人 / 优先级 / 严重程度 / 来源 / 客户 / 所属产品 / 归属项目 / 版本 / 标签 / 抄送 / 参与者 / 计划时间）。
  - **需求**：需求背景 / 详细描述 / 使用频率 / 紧急程度描述 + 基础字段（负责人 / 优先级 / 来源 / 客户 / 所属产品 / 版本 / 归属项目 / 标签 / 抄送 / 参与者 / 回访收集）。
- Token 仅存于 `~/.nezha/settings.json`，由 `yunxiao.rs` 使用；Agent（Claude Code / Codex）是 Nezha 拉起的独立 CLI 进程，**不持有也不会持云效 token**。
- SkillHub 本地仓库：`~/.nezha/skill_repos/codeup.aliyun.com-641881e9b9581d62e8f8186e-HSP-SkillHub.git`，已有 skill 为纯指令式（如 `issue-value-scoring`，`scope: project` / `project: HIS`）。

---

## What — 你的想法

在 Nezha 云效议题模块增加一个**反向闭环**：任务 X 运行中（讨论/执行），Agent/用户发现一个新问题需要立项，手工调用一个 Skill（`yunxiao-backfill-issue`），按议题类型**盘问**补全模板字段，经最终汇总预览确认后，由**持有 token 的 Nezha** 创建云效议题 Y，并**自动生成一个绑定 Y 的本地待办任务**（任务 ↔ 议题 1:1，落成待办不抢跑）。

**核心交互（CLI 讨论中的一段）：**

```
…（任务 X 正在讨论）
Agent: 这里发现了一个新的异常，是否要立项？我可以帮你补录一个云效议题。
用户:  用 backfill skill 建一下
Agent: 这是一个缺陷还是需求？ [缺陷] [需求]
用户:  缺陷
Agent: （按缺陷模板逐项盘问）
       缺陷描述：…  发生频率：…  影响范围：…  业务影响：…
       （每项给出模板引导语，可补充/跳过）
Agent: 以下是最终议题预览，确认后创建？
       标题：医保主表合同单位回写不匹配
       缺陷描述：…  发生频率：必现  影响范围：全院 …  业务影响：影响医保报销 …
       负责人：苏一  优先级：P1  严重程度：3.一般  来源：内部反馈  归属项目：Hsp 2.0
用户:  确认
[Nezha 调 CreateWorkitem 建 Y → 自动新建待办任务 Y，来源可溯]
```

### 功能清单（v1）

1. **Skill 触发**：任务运行中手工调用 `yunxiao-backfill-issue`（SkillHub 仓库内 skill，随项目安装）。
2. **总结上下文**：Skill 从当前会话/讨论中拎出未立项的异常作为议题素材。
3. **判类型**：先问「缺陷还是需求」→ 选对应模板。
4. **类型化盘问**：按模板内容段逐字段问（每段带模板引导语），标题由 Agent 从上下文拟、可改；基础字段不全问。
5. **最终汇总预览**：组装「标题 + 内容段 + 基础字段」，用户确认（可改）；确认即人工闸。
6. **落请求**：Agent 按模板结构写 `.nezha/drafts/<taskId>/backfill-issue.json`。
7. **近实时建 Y**：Nezha 侦测到该文件 → `CreateWorkitem` 建 Y（token 留在 Nezha）；内容段拼 description、基础字段映射到可写字段。
8. **自动待办 + 绑定**：建任务 Y（`status=todo`、`yunxiaoWorkitemId=Y`、`derivedFromTaskId=X`、`derivedFromWorkitemId=X`），云效侧来源可溯（描述带来源行，不覆盖「来源*」基础字段）。

### 基础字段回填规则

| 字段 | 取值 |
|------|------|
| 负责人 | 云效 token 当前用户（复用 `fetch_current_user_id`） |
| 优先级 | Agent 判断（复用 `issue-value-scoring` 推导：Bug→优先指数 / Req→核心指数） |
| 严重程度 | Agent 判断（Bug 走 value-scoring 严重程度维度）或模板默认 |
| 来源 | 默认「内部反馈」（**不被**溯源覆盖） |
| 归属项目 | 当前加载云效议题所在 projectId 回填 |

> 客户 / 版本 / 标签 / 抄送 / 参与者 / 回访收集 / 计划时间：v1 **不强制写**，保留在模板配置中待扩展。

### 明确不做（v1 非目标）

- **不写回源议题 X 的方案汇总**（「回写云效」仍走现有 done 后流程，与本功能正交）。
- **不建云效「关联工作项」关系**（来源走描述 + 本地字段，留作后续）。
- **不做任务 ↔ 议题多对多**（保持 1:1）。
- **不自动启动**新任务（Y 落待办，人工把关启动）。
- **不在 Nezha 侧做独立模板编辑 UI**（模板随 Skill 走，改 SkillHub 仓库文件即维护）。

---

## Why — 动机和原因

**痛点场景：** 云效议题模块目前全是**正向**流程（议题 → 导入 → 待办 → 会话 → 回写）。但团队经常在 **AI 讨论 / 执行的半路**发现新问题，需要**补录**成正式议题。现状下没有通道，只能：切出当前会话 → 手动去云效新建（且要按模板逐项填）→ 回来继续；且新议题与当前任务/讨论没有关联，无法追溯到「这个问题是哪个任务、哪次讨论发现的」。

**期望行为：** 讨论/执行中途发现新问题，手工调 Skill → 被盘问补全 → 确认 → 议题在云效建好 + 自动出现一个绑定待办；任务与议题 1:1 天然关联，来源可溯（云效侧描述带来源行、本地 `derivedFrom*` 可查）。

**为什么优于其他备选：**

- 优于「事后手动去云效补录」：把模板字段/引导语盘问自动化，减少漏填、错类型；且不打断正在跑的会话。
- 优于「让 Agent 直接调云效 API 建」：token 不离开 Nezha（安全），Agent 只负责「总结 + 盘问 + 产出结构化请求」，符合现有「Agent 写草稿、Nezha 干活」的模式。
- 优于「在 Nezha 里加一个独立建议题表单 UI」：用户已明确要 CLI 里 Skill 驱动，且模板可维护性借此落地（随 Skill 走、版本化）。
- 优于「维持现状、只靠 commit tag 关联」：tag 只关联**代码**，不解决「补录议题与讨论任务的来源关系」，也产不出带模板结构的正式议题。

---

## Scope — 影响面

### 后端（Rust，`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `yunxiao.rs` | `CreateWorkitem` 增强：支持 Bug / Req 类别 + 基础字段映射（assignedTo / priority / severity / customFieldValues / spaceId / workitemTypeId）；新增解析 `backfill-issue.json` 并建 Y + 建待办任务的命令（token 仍由后端持有） |
| `drafts.rs` | `ALLOWED_DRAFT_FILES` 增加 `backfill-issue.json`；提供读取 |
| 新增（可并入 `drafts.rs` 或独立） | `backfill-issue.json` 近实时侦测（复用 `event_watcher` 思路：亚秒级文件监听/轮询），落请求可靠触发建 Y |
| `storage.rs` | `Task` 新增 `derivedFromTaskId?` / `derivedFromWorkitemId?`（可选，`skip_serializing_if`，向后兼容） |
| `lib.rs` | 注册新命令 |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `types.ts` | `Task` 新增两字段；新增 `BackfillIssueRequest` 类型 |
| `App.tsx` | 收到「backfill 请求」事件 → 建待办任务（绑定 Y、来源字段）→ `persistProjectTasks` |
| `utils/yunxiao.ts` | 构建来源行 / 议题链接 |
| 待办链路 | 复用现有 todo → 启动会话，零改动为主 |

### Skill 仓库（HSP-SkillHub）

新增 `yunxiao-backfill-issue/`：

- `SKILL.md`：流程（总结 → 判类型 → 盘问 → 预览确认 → 写 `backfill-issue.json`）+ 字段回填规则说明。
- `templates/bug.json`、`templates/req.json`：结构化模板（contentSections + baseFields：key / label / 引导语 / 必填 / 顺序 / 默认值 / 选项），Nezha 与 Agent 共用（同源）。

### 安全

- token 全程留在 Nezha，不下放给 Agent；不打印日志、不进错误提示。
- `backfill-issue.json` 读取沿用 `drafts.rs` 的白名单 + canonicalize + `starts_with` 校验 + 大小上限。
- 云效响应域名白名单校验（`*.aliyuncs.com` / `*.alicdn.com` / `*.aliyun.com`）。
- 不触及终端性能红线；不新增全局事件广播。

### 不触及

- 终端写入链路（`useTerminalManager` / `pty.rs` / `TerminalView` / `terminalShared`）不改。
- 不回退单值 `yunxiaoWorkitemId` 模型（保持 1:1）。
- 不引入多对多议题关联、不建云效关联关系、不加 UI 模板编辑器。

---

## 交互状态覆盖（PR 截图要求）

- Skill 触发后：判类型提问态 / 盘问中态 / 最终预览态 / 确认后提示态。
- Nezha 侧：收到请求后创建中 / 创建成功（出现待办）/ 创建失败（可读错误）。
- 暗色 + 亮色主题；空态（无可立项问题）/ 取消态。

> 主要为 CLI 会话交互 + 待办列卡片变化，需录屏一段讨论中调 skill → 建议题 → 待办冒出的完整流程。

---

## 附录 A：Grill 会话已确认决策

1. **关联模型**：任务 ↔ 议题 **1:1**（一个任务只能是一个议题）。
2. **反向场景**：任务绑议题（发现新问题 → 拆新任务）与自由任务（发现 → 建新任务）都统一——补录一律新建议题 + 新待办任务。
3. **触发**：CLI 讨论/执行中**手工调 Skill**。
4. **机制**：**代理式**——Skill 总结上下文 + 盘问 + 产 `backfill-issue.json`，Nezha 持有 token 建 Y。
5. **判断类型**：开头先问「缺陷还是需求」。
6. **确认闸**：盘问完 → **最终汇总预览** → 用户确认后才建。
7. **时序**：**近实时**建 Y（不等任务 X done），落成**待办**（不自动启动）。
8. **模板**：**跟 Skill 走**，放 SkillHub 仓库（结构化文件），Nezha 与 Agent 同源共用；改 skill repo 即维护。
9. **来源追溯**：云效描述带来源行 + 本地 `derivedFromTaskId` / `derivedFromWorkitemId`；**不覆盖「来源*」基础字段**（来源默认「内部反馈」）。
10. **字段回填**：负责人=token 当前用户、优先级=Agent 判断（复用 value-scoring）、严重程度=Agent 判断（Bug）、来源=默认「内部反馈」、归属项目=当前议题 projectId。
11. **v1 范围**：核心环（标题/描述/负责人/优先级/严重程度/来源/归属项目）；客户/版本/标签/抄送/参与者/回访收集保留模板待扩展。
12. **工程约束**：token 不下放 Agent；沿用 drafts 白名单校验；schema 双端同步；新命令注册 `lib.rs` 并守 `spawn_blocking` / 锁作用域规范；不触及终端性能红线。

## 附录 B：后续迭代候选

- **R1** 建云效「关联工作项」关系（若 API 支持）。
- **R2** 模板维护入口（Nezha UI 编辑器写回 skill repo）。
- **R3** 更多基础字段写回（客户/版本/标签/回访收集等，视 API 支持情况）。
- **R4** 自动发起讨论素材预填（判「已有同类议题」去重）。
- **R5** 讨论中一键「沿用当前议题」vs「全新议题」的选择。

## 附录 C：验证清单（开发完成时）

- [ ] `cargo check` / `cargo test --lib`、`pnpm build` / `pnpm test` / `pnpm lint` 通过。
- [ ] 真实 token 复验：`CreateWorkitem` 建 Bug / Req 带基础字段成功；错误 token/字段给出可读错误。
- [ ] Agent 走 skill 盘问 → 写 `backfill-issue.json` → Nezha 近实时建 Y + 待办任务；任务 done 后回写 X 仍正常（与补录正交）。
- [ ] 来源追溯：Y 描述含来源行；本地任务 Y 的 `derivedFrom*` 正确。
- [ ] 去重：同一「源任务+内容签名」不重复建。
- [ ] token 不出现在日志与错误提示；路径校验对 `..`/分隔符拒绝。
