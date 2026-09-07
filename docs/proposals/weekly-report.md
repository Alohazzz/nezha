# 需求：Nezha 周报 —— 统计与上报（v1 只做统计 + 视图）

> 状态：**需求文档（已立项）**——Issue #68（https://github.com/Alohazzz/nezha/issues/68）。
> 正文以「技能 + 页面」两段组成：统计逻辑下沉为 SkillHub 技能（`weekly-report`），Nezha 增加应用级「周报」视图渲染其 Markdown 输出。
> 已确认口径：**只统计成本（会话数）与产出（按项目×天、一天一行），去 token、去时长**；上报渠道后置。

---

## 背景事实（代码/环境查证）

- `Task` 只有 `created_at` / `updated_at`，**无 `completed_at`**；且 HIS 项目本周任务已被清理，任务层无法体现“本周完成了什么”，**必须由会话数据驱动**。
- 会话数据：Codex 存 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`（`session_meta.cwd` 可定位项目、首个 `user_message` 即主题），Claude 存 `~/.claude/projects/*/*.jsonl`。
- `analytics.rs` 仅对前端暴露 `total_tokens`（cache+reasoning 合并），无 input/output/cache 分档，token 数字明显失真，故**统计中去掉 token**；时长把“长会话跨天”算进墙钟，虚高，一并去掉。
- 项目映射源：`~/.nezha/projects.json`。临时 worktree（如 `分支合并临时/HSP_HIS`）未登记，会归为「临时 worktree」。
- 未登记会话会产生“无主题”噪声，采用去重 + 短标题（`[Image #N]`、`$mode` 前缀清理）。
- 现有可复用：`TimelineView`（跨项目、按 bucket→项目分组）作为「周报」视图的原型参照；`marked` + Shiki 已用于 Markdown 渲染；`export_session_markdown` / `codeup_export_review_report` 有导出先例。

---

## What — 你的想法

### 1. SkillHub 技能 `weekly-report`（已落地）

`~/.nezha/skill_repos/...HSP-SkillHub.git/weekly-report/`，`scope: universal`。

- `SKILL.md`：定义周的定义（自然周周一→周日，本机时区）、统计口径、输出模板、约束。
- `scripts/build_weekly_report.mjs`：确定性聚合 —— 读会话文件按目录日期归周、按 `cwd` 映射项目、按【项目→天】聚合成**一天一行**，统计会话数与各仓库 git 提交数，输出 Markdown 到 stdout。
- 示例输出（上周 2026-08-31 ~ 09-06）：会话数 78、涉及项目 4、git 提交 83；每项目每天一行（日期 + 当日主题 + `N 条会话`）。

### 2. Nezha「周报」视图（本提案主体）

- **入口**：应用级，与 `TimelineView` 同级（WelcomePage 或头部快捷入口）。跨项目聚合，按项目分组。
- **顶部**：标题「周报」+ 周选择器（本周 / 上周 / 更早）+「复制 MD」按钮 +「上报（待定）」置灰。
- **统计卡**：会话数 · 涉及项目 · git 提交。
- **本周做了什么**：按【项目 → 天】分组，**一天一行**（日期 + 状态点 + 当日主要主题 + `N 条会话`），组内日期正序，可折叠。
- **Git 提交**：各仓库提交数网格。
- **数据流**：占位为先 —— 后端新增 Tauri 命令 `build_weekly_report`（Rust，`spawn_blocking`），要么直接跑 SkillHub 技能脚本，要么在 Rust 内同口径聚合，返回结构化数据（视图用）+ Markdown（「复制 MD」用）；再让视图按模板渲染。**不新增持久化的“周”实体**，纯查询。

---

## Why — 动机和原因

当前 Nezha 已覆盖“做 → 看到过程”，但缺一个以时间周期为骨架的「计划→执行→收尾」闭环。本次先补**收尾（统计/周报）**：开发者周末要花时间手写周报，且现有数据（任务被清理、token 失真、时长虚高）无法直接支撑可信周报。把统计下沉为**确定性技能**（只聚合真实会话 + git，不靠 LLM 编），既诚实又可直接被页面渲染；后续要“上报成文”时拿这份真实数据做 LLM 汇总即可。

取舍：v1 刻意**去 token / 去时长 / 去卡点信号**，因为这几项当前口径不可信或会虚高；宁缺毋滥，先把「会话数 + 做了什么 + git 提交」三块做到可信、简洁。

---

## Scope — 影响面

- 涉及模块：`src/`（新增 `WeeklyReportView`，样式进 `src/styles/`，不写 inline `style={{}}`）、`src-tauri/src/`（新增 `weekly_report.rs` 或并入现有 `analytics`/`git`，注册到 `lib.rs::invoke_handler!`）。
- **不触碰**：终端性能红线相关文件（`TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts`）；不改 `Task` schema（本期不引入 `completed_at`，会话按目录日期/mtime 归周即可；如需精确“完成任务数”，再在后续迭代加 `completed_at`）。
- 后端命令遵循 `spawn_blocking` / 流式读大 JSONL / 路径校验；`Task` schema 本次不动，无迁移风险。
- 不破坏现有功能；`read_session_metrics` 等保持原样。

---

## 明确不做（v1 非目标）

- **上报渠道**（云效贴评论 / 建工作项 / 导出 / 钉钉）——按钮置灰，后续定。
- LLM 叙述 / 结构化“完成文案”——统计是确定性数据，成文留后续。
- 计划功能（周计划 / 工作周实体）——本次只做统计。
- token / 时长 / 卡点信号（失败分布、被打断、`input_required`）——口径待校验后再加。
- git +/- 行、MR 合并明细、issue 闭环数——后续按需补。
