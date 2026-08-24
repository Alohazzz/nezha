# 需求：云效议题闭环提速——讨论产物落盘草稿，回写/沉淀直接读取（v4）

> 状态：**需求文档（已与需求方 grill 确认，进入开发）**——实现已完成本地首版，待 issue-first 提案流程。
> 承接：`yunxiao-v3-close-loop-and-images.md`（回写闭环 + 提交关联）、`yunxiao-knowledge-sedimentation.md`（知识沉淀）。
> 分支：跟随云效 V3 迭代分支实现。

---

## 背景事实（代码/环境查证）

- 回写云效：点击后调 `generate_yunxiao_writeback_summary`
  （`src-tauri/src/agent_assist.rs`），headless Agent 重新读会话摘要（8000 字截断）
  + git 事实 → 生成汇总 → 预览。慢在「重新读会话重建内容」。
- 知识沉淀：点击后调 `generate_knowledge_sedimentation`，从 SkillHub 读
  `knowledge-sedimentation/SKILL.md` 注入 headless → JSON 候选 → 预览。慢在
  「读取技能 + 重新比对图谱」。
- 讨论提示词：`agent_assist.rs::issue_discussion_instructions`（Req → grilling 产出
  What/Why/Scope 提案；Bug → diagnosing-bugs 产出根因+修复方案）+ his-knowledge-graph
  指令，前端 `YunxiaoIssueDetailView` 发起讨论时拼进 prompt。
- 运行时：Agent cwd = worktree（`<项目>/.nezha/worktrees/<taskId>/`）或项目根；
  `.nezha` 已 gitignore（HIS 与 nezha 仓库均确认），写入工作目录内不会污染 git status；
  附件目录 `<项目>/.nezha/attachments/<taskId>/` 在任务终态清理。

---

## What — 你的想法

把「修改过程中 AI 本来就产出的内容」在会话中落盘到本地草稿文件，点击回写/沉淀时直接读取，
不再事后重建：

1. **讨论产物落盘**：讨论提示词追加「工作产物落盘」指令，Agent 在工作目录下维护
   `.nezha/drafts/<taskId>/discussion.md`（回写云效的「修改方案汇总」：
   背景/目标、分析结论、最终方案、验证、关联 commit；结论更新即整体覆盖写）。
2. **知识沉淀落盘**：任务收尾前 Agent 按内嵌规则产出 `.nezha/drafts/<taskId>/knowledge.json`
   （JSON 数组：module / section / content / evidence / confidence / suggestedTitle）。
3. **任务收尾收拢**：`run_task` / `resume_task` 登记真实项目根；任务转 `done` 时
   （自然退出 `finalize_task_exit` 或手动 `complete_task`）把 worktree 内的草稿收拢拷贝到
   项目根 `.nezha/drafts/<taskId>/`，读取位置与 worktree 生命周期解耦。
4. **按钮读取优先**：
   - 回写云效：有 `discussion.md` → 直接作为可编辑预览（秒开）；无 → 回退现有 headless；
     「重新生成」强制走 headless。
   - 知识沉淀：有 `knowledge.json` → 直接解析为候选列表；无/解析失败 → 回退 headless；
     「重新生成」强制走 headless。
5. **技能废弃**：`knowledge-sedimentation` 的提取规则（六段骨架、依据门槛、置信度、
   输出格式）内嵌为 `agent_assist.rs::KNOWLEDGE_SEDIMENTATION_RULES`，讨论提示词与
   headless 降级共用；Nezha 不再读取技能仓库，SkillHub 中的 SKILL.md 可后续删除。

## Why — 动机和原因

- 现状：每次议题完成后，点「回写云效」/「沉淀知识」都要 headless Agent 重新从会话里
  提取/重建内容，耗时且依赖会话摘要质量；讨论中 AI 已经产出的结论没有留存通道。
- 期望：讨论/修改过程中产物自然落盘，点击按钮即读文件 + 人工确认，闭环从「分钟级生成」
  变成「秒开确认」。
- 为什么优于备选：
  - 优于「点击时优化 headless 提示词」：治标不治本，仍要重读大段会话；
  - 优于「直接让 AI 写回云效/图谱」：保留人工预览确认与审核闸门，且不改云效/图谱资产
    的写入边界；
  - 优于「持久化到应用级目录」：Agent 在非 full_access 沙箱下写不出去，落 cwd 内
    （worktree/项目根）零权限摩擦。

## Scope — 影响面

### 后端（`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `drafts.rs`（新增） | 草稿目录/路径校验（白名单 + canonicalize + 大小上限）、草稿读取、worktree → 项目根收拢；含单测 |
| `agent_assist.rs` | `issue_discussion_instructions(category, task_id)` 追加落盘指令；`KNOWLEDGE_SEDIMENTATION_RULES` 内嵌规则；`generate_yunxiao_writeback_summary` / `generate_knowledge_sedimentation` 加 `task_id` + `force`，草稿优先、无则 headless 降级；知识沉淀降级不再读技能仓库（图谱目录仍读 his-knowledge-graph） |
| `pty.rs` | `run_task` / `resume_task` 增加 `real_project_path` 并登记；`finalize_task_exit`（done）/ `complete_task` 收拢草稿 |
| `lib.rs` | 注册 `drafts` 模块；`TaskManager` 增加 `task_real_paths` |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `App.tsx` | `invokeRunTask` / `invokeResumeTask` 传 `realProjectPath`；回写/沉淀 handler 传 `taskId` + `force` |
| `YunxiaoIssueDetailView.tsx` | 取讨论指令时传 `taskId` |
| `ProjectPage.tsx` | 「重新生成」传 `force=true`；props 类型加可选 `force` |

### 技能仓库（HSP-SkillHub，后续）

- `knowledge-sedimentation/SKILL.md` 随本迭代废弃，待后续 commit 删除（需推送到
  codeup；规则已内嵌 Nezha，不依赖该文件）。

### 安全

- 草稿读取：文件名白名单 + 项目根 canonicalize + starts_with 校验 + 2MB 大小上限；
  `task_id` 拒绝路径分隔符/`..`。
- 不触及终端性能红线；不新增全局事件广播。

### 明确不做（v1）

- 不做草稿自动清理（`<项目>/.nezha/drafts/` 为 gitignore 小文件，随任务长期保留；
  后续可加「回写+沉淀均完成后清理」）；
- 不改云效 API 与知识图谱写入边界；审核通过后的图谱更新仍人工执行；
- 不删除 SkillHub 中的 SKILL.md（待 codeup 推送权限与流程确认后单独处理）。

## 验证

- `cargo check` / `cargo test --lib`：新增 drafts 单测 + 指令/解析单测通过；
  唯一失败为 `session.rs` 既有 Windows 路径测试（POSIX 硬编码，与本改动无关）。
- `pnpm build` / `pnpm test` / `pnpm lint` 通过（1 个下拉滚动测试偶发超时，
  单跑通过，与本改动无关）。
- 端到端（需重启 tauri dev 后人工验证）：发起云效讨论 → Agent 落盘
  `discussion.md`/`knowledge.json` → 任务 done 收拢 → 回写/沉淀按钮秒开读取 →
  编辑确认 → 无草稿任务回退 headless → 「重新生成」强制 headless。
