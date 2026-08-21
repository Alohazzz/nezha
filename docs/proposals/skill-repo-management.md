# 需求：Skill 仓库管理 —— 用户指定技能来源，启动自动同步（v1）

> 状态：**已确认，进入开发**——grilling 决策树已走完，issue-first 已发布并获确认。
> 仓库：https://github.com/Alohazzz/nezha（本地 remote 实测）
> Issue：#10（https://github.com/Alohazzz/nezha/issues/10）
> 承接：现有 SkillHub 机制（`skills.rs` + `src/components/skill-hub/` + `SkillsPanel`），
> 本迭代把「hub = 手动指定的本地目录」升级为「hub = 用户指定的技能仓库（本地路径或 git 远端），
> 启动/变更时自动同步」。价值评分等规则类技能的内容与云效字段回写**后置**，不在本迭代。

---

## 背景事实（代码查证）

- 现有 SkillHub 已具备：`SkillHubConfig`（存 `~/.nezha/skill_hub.json`，字段
  `hubProjectId` / `hubPath` / `createdAt`）、`set_skill_hub_path` / `clear_skill_hub`、
  `list_skills`（递归扫描含 `SKILL.md` 的目录，跳过隐藏目录，技能可放任意层级）、
  `install_skill` / `uninstall_skill`、`list_skill_installations`（健康检查
  ok / broken / diverged）、`delete_skill`、`cleanup_installations_for_project`；
  hub 目录会作为一个 project 注册进 `projects.json`（复用现有文件浏览/任务链路）。
- `install_skill` 在项目 `.claude/skills/<name>` / `.codex/skills/<name>` 建立
  **软链**指向 hub 内的技能目录（Windows 为目录软链）。因此 **hub 内容更新后，
  已安装技能自动跟随**，无需重装；技能在 hub 内被改名/删除时，安装记录健康状态
  变为 broken / diverged（现有检查已覆盖），由用户手动卸载。
- App 启动时前端已调用 `get_skill_hub_config`（`App.tsx`），技能库页
  （`SkillHubView`）与设置页（`SkillsPanel`）都会消费该配置；配置变更通过
  `SKILL_HUB_CHANGED_EVENT` 同步刷新。
- `fs_watcher.rs` 使用 `notify` crate 做文件变更监听（对项目根**禁止**递归 watch
  是红线——node_modules 会撞 `max_user_watches`；技能仓库规模小，递归 watch 安全）。
- 仓库既有「技能随仓库走」的先例：`.codex/skills/nezha-build-launch/`。

---

## What — 你的想法

把「技能库来源」从「手动指定本地目录」升级为「用户指定的技能仓库」：

1. **来源配置（单一来源）**：应用设置 → SkillsPanel 升级为「技能仓库来源」——
   - 本地目录：沿用现有目录选择器（行为与现状一致）；
   - git 远端：URL 输入框 + 可选分支（缺省跟随远端默认分支）。
2. **git 源同步（遵循 Git 原则）**：后台异步，**绝不阻塞启动**——
   - 缓存缺失：`git clone --depth 1 <url> ~/.nezha/skill_repos/<sanitized-name>/`；
   - 缓存存在：`git fetch` 探测远端变更，**有变更才** `git pull --ff-only`
     （不自动 reset，不覆盖缓存内可能的本地改动）；
   - 失败/离线：继续用上次缓存，配置标记 stale + 上次错误，UI 可手动「立即同步」重试。
3. **本地路径源同步**：复用 `notify` 对技能仓库目录挂递归 watch（规模小，不触项目根
   红线），文件变更即重扫。
4. **探测时机**：启动时异步一次 + 窗口聚焦 + 每 30–60 分钟周期探测；本地源实时。
5. **状态展示**：SkillHubView 头部显示来源、上次同步时间、当前 commit、过期/失败标记，
   并提供「立即同步」按钮。
6. **失效安装治理**：不做自动删除；同步后技能被改名/删除 → 健康标记 broken/diverged，
   用户手动卸载；新增「清理全部失效安装」按钮（仅删软链与记录，不删任何普通目录）。

**核心交互（低保真）：**

```
┌─ 应用设置 · 技能 ───────────────────────────────────────────┐
│ 技能仓库来源                                                 │
│ (●) 本地目录   [H:\...\skills ▼ 选择]                       │
│ ( ) git 远端   [https://github.com/x/skills.git]  [分支: _]  │
│ 技能库路径：H:\...\skills   （git 源时显示缓存路径）          │
└──────────────────────────────────────────────────────────────┘

┌─ 技能库（SkillHubView 头部）────────────────────────────────┐
│ 技能库 · 来源: git@github.com:x/skills.git                  │
│ 上次同步: 2 分钟前 · commit abc1234 · [立即同步]             │
│ 状态: ✓ 最新  /  ⚠ 同步失败，使用缓存（上次: 2 小时前）      │
├──────────────────────────────────────────────────────────────┤
│ 技能列表 …（现有行 + 健康标记 + 管理/删除）                   │
│  [清理全部失效安装]                                          │
└──────────────────────────────────────────────────────────────┘
```

### 明确不做（v1 非目标）

- 不做多来源（多个仓库并存）——v1 单一来源，后续再扩。
- 不做技能版本选择/固定 commit——跟随远端默认分支，仅展示当前 commit。
- 不做「同步后自动安装新技能到项目」——安装仍按项目手动选择。
- 不做价值评分 Skill 内容与云效「价值评分」字段回写——机制先落地，内容后置。
- 不引入自研变更协议——变更检测/分发完全走 git 语义（fetch 探测 + ff-only 更新）。

---

## Why — 动机和原因

**痛点场景：**

- 当前 hub 只能手动指定本地目录：技能分发靠人工拷贝/改配置，多机之间无法同步；
  团队想统一维护一批技能（如价值评分这类「规则型技能」）时没有版本化、可评审、
  可回滚的渠道。
- 手动指定的本地目录在他人机器上不存在，技能库天然不可迁移。

**期望行为：**

用户填一个仓库地址（或本地路径），Nezha 启动时自动拉到最新；技能内容随仓库版本走，
已安装项目通过软链零成本跟随更新；同步失败不阻塞使用，只标记并允许重试。

**为什么优于其他备选：**

- 优于「继续手动本地目录」：解决分发与多机同步，技能内容可评审、可回滚；
- 优于「内置技能目录写死在 Nezha 仓库」：来源由用户指定，团队可用自己仓库，
  与 Nezha 主仓库发布节奏解耦；
- 优于「自研变更检测/下载协议」：git 本身是成熟的变更检测与分发协议，
  fetch + ff-only 即「文件发生变更才拉取」，不重复造轮子；
- 优于「启动阻塞同步」：离线/慢网不拖垮启动体验，缓存 + stale 标记是合理兜底。

---

## Scope — 影响面

### 后端（Rust，`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `skills.rs` | `SkillHubConfig` 扩展：`source { type: "path"\|"git", path?, url?, branch? }` + `lastSyncedAt` + `lastSyncedCommit` + `lastSyncError`；旧配置无 `source` 视为本地路径（零迁移）。新增命令：`set_skill_source`（path/url + 可选分支，git 源触发首次 clone）、`sync_skill_source`（立即同步，返回状态）、`get_skill_source_status`、`clear_skill_hub` 扩展为同时清理 watcher/缓存配置（不删缓存文件）、`cleanup_broken_skill_installations`。git 子进程封装：参数化 `Command`（不经 shell）、`--depth 1` clone、`fetch` + `--ff-only` pull、超时 + `kill_on_drop`；URL scheme 白名单（`https://` / `git@` ssh）；缓存目录名 sanitize（非法字符替换，禁止路径穿越）。 |
| `fs_watcher.rs`（或独立轻量 watcher） | 本地路径源：对技能仓库目录挂递归 watch（`notify`），变更防抖后触发重扫/刷新事件；watcher 不可用时回退启动扫描 + 手动刷新。 |
| `lib.rs` | 注册新命令。 |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `types.ts` | `SkillHubConfig` 扩展（`source`、同步状态字段）；新增 `SkillSource` / `SkillSourceStatus` 类型。 |
| `components/app-settings/SkillsPanel.tsx` | 来源配置 UI：本地目录（沿用选择器）/ git URL（输入 + 可选分支）；展示解析后的 `hubPath`（git 源显示缓存路径）。 |
| `components/skill-hub/SkillHubView.tsx` | 头部来源/同步状态（上次同步时间、commit、stale/失败标记）+「立即同步」；列表底部「清理全部失效安装」按钮。 |
| `styles/skill-hub.ts` / `styles/app-settings.css` | 新增状态样式（不写 inline style，主题变量走 CSS 自定义属性）。 |
| `i18n.tsx` | en/zh 文案：来源类型、URL 输入、分支、立即同步、上次同步、commit、stale/失败、清理失效等。 |

### 数据 / 迁移

- `~/.nezha/skill_hub.json`：新增可选字段，`serde(default)` 兼容旧数据，**无迁移脚本**；
  旧配置（只有 `hubPath`）等价于 `source.type = "path"`。
- git 源缓存：`~/.nezha/skill_repos/<sanitized-repo-name>/`，不入 `projects.json`
  （hub project 记录仍保留，指向缓存目录，行为与现状一致）。

### 安全

- git URL 只允许 `https://` 与 `git@`（ssh）scheme，拒绝其他协议与本地路径伪装；
- git 命令全部参数化传递（`std::process::Command`），不经 shell，不拼接用户输入；
- 缓存目录名 sanitize 后拼接在 `~/.nezha/skill_repos/` 下，禁止路径穿越；
- 命令超时 + `kill_on_drop(true)`；同步失败信息不含凭据/完整 URL 的敏感参数。

### 不触及

- 终端性能红线：不改 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` /
  `pty.rs` 写入链路；
- 不新增全局事件广播：复用 `SKILL_HUB_CHANGED_EVENT`；
- 不改云效回写链路；价值评分 Skill 内容与云效字段回写为后续迭代。

---

## 验证

- `cargo check` / `cargo test`、`pnpm build`（tsc）/ `pnpm test` 通过。
- 真实 git 复验：公有/私有仓库 clone、fetch + ff-only 更新、离线/网络失败回退缓存
  （stale 标记）、本地目录 watch 变更重扫、技能改名/删除后的 broken/diverged 标记与
  「清理全部失效安装」。
- 配置兼容：旧 `skill_hub.json`（无 `source`）加载后等价于本地路径源，行为不变。
- UI 状态覆盖：未配置 / 本地路径 / git 同步中 / 同步成功 / 同步失败(stale) / 清理中，
  暗色 + 亮色主题截图各一张。

---

## 附录 A：Grill 会话已确认决策

1. **范围**：先实现「Skill 仓库管理」机制；价值评分 Skill 内容与云效字段回写后置。
2. **来源形态**：本地目录路径 + git 远端 URL 都支持，v1 单一来源。
3. **同步语义**：后台异步、不阻塞启动；git 源缺失则 shallow clone，存在则
   fetch 探测 + 变更才 `--ff-only` pull；失败用缓存 + stale 标记 + 手动重试。
4. **探测时机**：启动 + 窗口聚焦 + 每 30–60 分钟；本地路径源用文件变更检测实时重扫。
5. **配置模型**：扩展现有 `SkillHubConfig`（`source` + 同步状态字段），
   `hub_path` 保持为最终扫描目录；旧配置零迁移。
6. **UI**：来源配置放应用设置 → SkillsPanel；同步状态 + 立即同步放 SkillHubView 头部。
7. **失效安装**：不自动删除；健康标记 + 手动卸载 + 「清理全部失效安装」按钮。
8. **git 原则**：变更检测/分发完全走 git 语义，不自研协议；不自动 reset，不覆盖本地改动。
9. **流程**：本提案文档 + GitHub issue（What/Why/Scope）→ maintainer `accepted` 后实现。
