# 调研：多项目 / 多仓库协同的编码智能体现状（2026-09）

> 目的：为「跨项目协同」提案（`docs/proposals/cross-project-solution-v1.md`）提供一手依据。
> 问题：市面上有没有「一个聊天框能识别任务该去哪个项目」的产品？agent 如何自管理任务与项目？
> 结论先行：**没有。所有产品都由人选项目；且 Paseo 恰恰明确拒绝多仓库。**
> 调研方法：一手来源优先（官方文档 / 源码 / 标准站 / HN API）。标注「未核实」的不要当结论用。
> 状态：调研事实部分可作参考；配套提案仍为草稿（见上方链接），结论未定。

---

## 1. Paseo（paseo.sh）—— 最常被提及，但它是反面案例

### 1.1 它是什么（已核实）

- 定位「编码智能体的控制平面」（The control plane for coding agents），**不是 agent 本身**。
- 形态：Electron 桌面端 + React Native 移动端（iOS/Android）+ Web + CLI/headless daemon + TypeScript SDK。
- 架构是明确的 **client-server**：一个 Node.js **daemon** 负责 spawn 各 agent CLI 并 stream（WebSocket）；桌面/移动/Web/CLI 都是 client。远程访问走直连 / SSH / Tailscale / 可选 E2E 加密 relay（默认关闭）。
- 文件持久化在 `$PASEO_HOME`（`~/.paseo`）。
- License **Apache-2.0**，仓库 [github.com/getpaseo/paseo](https://github.com/getpaseo/paseo)（16k+ star，作者 Mohamed Boudra）。
- **不支持多仓库**（下文 1.3 有硬证据）。

### 1.2 对象模型：Project → Workspace → Agent session（已核实，来自其 `docs/glossary.md` / `docs/data-model.md`）

| 实体 | 定义（原文要点） |
|---|---|
| **Project** | 「一个稳定、精确选定的根目录记录」，ID 形如 `prj_<16 hex>`。术语表**明确禁止**用 "Repo" 当 UI 词。 |
| **Workspace** | 「一个 daemon 上的一个具体 `cwd`，带 git 状态；**belongs to exactly one project**」。 |
| **Agent session** | 「一个 workspace 内一个 agent 的运行实例（一个 provider / 一个 model / 一个 cwd / 一条 timeline）」。术语表**禁止**用 "Task" / "Job" / "Run"。 |
| **Daemon / Host** | daemon = 本地服务进程；host = client 侧连接配置。 |

注意：Paseo **没有 Task 实体**，原子单位是 agent session。

### 1.3 「去哪个项目」永远是人的动作（已核实）

数据模型原话：**"The workspace record is then the durable placement authority: `cwd` is the exact execution directory."** 即 agent 拿到的是一个确定的 `cwd`，它没有选择权。

- UI：`Add project`。
- CLI：`cd` 进目录后 `paseo project create`；远程 `paseo --host devbox:6767 project create /srv/repos/api`。运行 `paseo run "…"`，落点优先级 `--workspace <id>` > `$PASEO_WORKSPACE_ID` > `--worktree` > 当前目录。
- Hub 触发器（GitHub/Slack/Discord）虽然能自动起 agent，但落点**在 YAML 里写死**：

  ```yaml
  run:
    target:
      daemon: laptop
      cwd: /Users/you/code/support
  ```

**硬证据（这三条最能说明问题）：**

- [PR #1461](https://github.com/getpaseo/paseo/pull/1461)「multi-repo projects：把一个装多个 git repo 的父目录当单个项目」——44 文件、+1050/-85，**closed，从未合并**。它引入的正是 `multi_git` project kind。
- [issue #1972](https://github.com/getpaseo/paseo/issues/1972)（导入 VS Code multi-root workspace）：正文写 **"Paseo currently gives an agent only one working directory"**，closed。
- [issue #1530](https://github.com/getpaseo/paseo/issues/1530)（支持 Claude Code `/add-dir`）：closed，标 `not_planned`。
- [issue #2174](https://github.com/getpaseo/paseo/issues/2174)（一个窗口 split pane 放不同项目的 agent）：bot 回复 **"Paseo currently scopes a split-pane layout to a single workspace, and each workspace maps to one project"**，closed。

### 1.4 上下文策略：故意不做（已核实）

- provider 文档原话：**"Paseo doesn't ship its own coding agent… launches and supervises existing CLIs you've already installed and authenticated, so your subscriptions, your config, your skills, your MCP servers all stay intact."**
- 即 `CLAUDE.md` / `AGENTS.md` / skills / MCP 配置**由底层 CLI 自己读**，Paseo 不加层。
- 跨 agent 传上下文靠显式通道：`/paseo-handoff` 技能、Fork（复制 chat history 为 attachment）；compaction 走 provider 原生 RPC，其 non-goals 明确写 **"A Paseo-owned context class system"**。
- Paseo 自己的 MCP 工具目录（`create_agent` / `send_agent_prompt` / `create_workspace` 等）`daemon.mcp.injectIntoAgents` **默认 false**，且原文声明 **"It is not a security boundary"**。

**可取之处**：它证明了「daemon 暴露 MCP/CLI 让 agent 能程序化创建别的 agent」这条路可行（Nezha 可复用）；以及「不透传上下文、让底层 CLI 保留原生语义」是正确的分层。

---

## 2. 同类产品横向对比

| 工具 | 形态 | 多仓库模型 | 谁决定落点 |
|---|---|---|---|
| **Paseo** | Electron+daemon | 严格单根，多 workspace 并列 | 人 |
| **Vibe Kanban** (Bloop) | OSS Rust/TS, `npx` | **Project 聚合多 repo；一个 workspace 可含多 repo，各自独立 git state，统一 diff** | 人（下拉选 project） |
| **Cursor Agents Window** | 商业 | 「work with agents across **all your projects from one place**」 | 人（选 environment） |
| **Conductor** | macOS app | **1 project = 1 repository**，1 repo 多 workspace，1 workspace 1 branch | 人 |
| **Sculptor** (Imbue) | OSS 桌面 | 1 workspace = 1 repo，多 tab | 人 |
| **Crystal → Nimbalyst** | OSS→商业 | session 导向，无 repo switcher | 人 / backlog |
| **Claude Squad** | Go TUI | workspace-per-task，无跨 repo | 人 |
| **cmux** (manaflow) | 终端 | 多 workspace 终端，非 repo 路由 | 人 |
| **Factory Software Factory** | 企业 | 组织级 repo coverage + **Triage 自动分派** | 事件驱动，路由规则写死 |
| **OpenHands Agent Canvas** | 自托管 | 挂 `PROJECTS_PATH`，agent 可访问其下所有项目 | 人 |
| **p0** (HN) | 商业 | 「multi-repo aware」，为所有 repo 建**协同 worktree**，维护跨 repo imports/API 契约/共享类型 | 人 |

**未核实（不要引用为结论）**：Codex cloud 的多 repo 行为、Jules 多 repo、Amp 多项目、Devin 每任务多 repo、Conductor 是否同窗口多项目。

**行业风险信号**：Vibe Kanban 母公司 **Bloop 已于 2026-04-10 关停**（官方博文原话：*"the vast majority are free users and we couldn't find a business model"*），项目转社区维护；Terragon 关停；Crystal 被 Nimbalyst 取代。**押注某个 orchestrator 的项目模型有平台风险。**

---

## 3. 机制真相：「agent 怎么知道任务属于哪个项目」只有一招

**所有 agent 的机制都一样且很土：process `cwd` + 向上遍历找指令文件。**

### 3.1 Codex（已核实，读的是源码，因为 docs 站 403）

源码 `codex-rs/core/src/agents_md.rs` 模块注释原文：

1. 「Determine the project root by walking upwards from the current working directory until a configured `project_root_markers` entry is found. When unset, the default marker list is used (`.git`).」
2. 「Collect every `AGENTS.md` found from the project root down to the current working directory (inclusive) and **concatenate their contents in that order**.」
3. 「**We do not walk past the project root.**」

- 分隔符常量：`AGENTS_MD_SEPARATOR = "\n\n--- project-doc ---\n\n"`。
- 同目录 `AGENTS.override.md` 优先于 `AGENTS.md`。
- **总量硬上限 `project_doc_max_bytes = 32768`（32 KiB）**，超了截断并告警。

### 3.2 Claude Code（已核实，官方 memory 文档）

- 层级（宽→窄）：managed policy > `~/.claude/CLAUDE.md` > `./CLAUDE.md` 或 `./.claude/CLAUDE.md` > `./CLAUDE.local.md` > 子目录嵌套（**懒加载**）。
- 关键原话：**"All discovered files are concatenated into context rather than overriding each other."** 顺序是「从文件系统根向下到工作目录」，越靠近 launch 位置的越后读。
- 子目录的 `CLAUDE.md` **启动时不加载**，只在 agent 真的读那个子树时才进上下文——**这才是 monorepo 的真正机制**。
- `@path` import 最多 4 跳；`claudeMdExcludes` 可按 glob 排除其他团队的 CLAUDE.md。
- Claude Code **不原生读 AGENTS.md**，官方 workaround 是 `@AGENTS.md` 导入或软链。

### 3.3 必须知道的坑：规范说覆盖，实现是拼接

- `AGENTS.md` **官方规范**（agents.md，已由 Anthropic/Block/OpenAI 捐给 Linux Foundation 的 AAIF，2025-12-09）写的是 **"the closest one takes precedence"**（覆盖语义）。
- 但 Codex 和 Claude Code 的实现都是**从根到 cwd 拼接**（叠加语义）。Codex 真正的 per-dir 覆盖只有 `AGENTS.override.md`。
- **按规范字面意思设计多项目上下文合并会踩空。**

### 3.4 跨根的能力（已核实）

- Claude Code：`--add-dir` / `permissions.additionalDirectories`。注意 **"Claude Code doesn't discover most `.claude/` configuration from these directories"**；要加载它们的 CLAUDE.md 需设 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`。subagents 的 `.claude/agents/` **会**从 `--add-dir` 加载。
- Codex：`--add-dir`，但**仅在 `workspace-write` / `danger-full-access` 下生效**（`codex-rs/tui/src/additional_dirs.rs` 会告警忽略），对应 `sandbox_workspace_write.writable_roots`。
- 相关 hook 事件（Claude Code）：`CwdChanged` / `DirectoryAdded` / `WorktreeCreate` / `WorktreeRemove`。

---

## 4. 为什么「自动路由」至今没人做

1. **repo 边界 ≠ 任务边界。** HN 上被反复引用（`jauntywundrkind`, objectID 48683361）：*"orchestration systems assume an agent lives in one worktree of one git repo"*，但 *"the repo boundary is often just not the task boundary."*
2. **跨仓库改动无法自动收口。** Vibe Kanban 支持多 repo 了，但仍要求「Create a PR for each repository」并按依赖顺序**手动合并**；Conductor 干脆 1 项目 1 仓库。
3. **没有跨项目的合成上下文。** 各仓库 `CLAUDE.md` 各管各的，不会合并；跨仓库任务的 canonical memory 不存在。真正有跨任务知识库的只有厂商侧（Devin Knowledge/Notes、Factory AutoWiki），开源侧空白。
4. **权限爆炸半径。** Claude 权限路径**不锚定 repo 根**（文档原话："Paths in the file don't anchor at the repository root"，而是锚定 session 的 primary working directory）；Codex 用按根的 `writable_roots`。agent 能写多 repo 时，安全推理显著变难。
5. **上下文窗口稀释。** HN 多处报告长会话 compaction 两三次后 agent 开始偏离指令、跨 repo 时更明显（`Topfi` objectID 49492740）。Codex 干脆把 project docs 硬限 32 KiB。

---

## 5. 值得复用的现成机制

- **指令文件分层**已是事实标准（AGENTS.md 生态）；Nezha 应复用而非自造。
- **worktree 是本地隔离的通用原语**（Conductor / Vibe Kanban / Sculptor / Crystal / Squad / Cursor / Factory 全用）。
- **MCP / CLI 作为 agent 的程序化入口**（Paseo、Vibe Kanban、Terragon、Omnara 都做），是「外部聊天框 → 创建任务」的标准通道。
- **跨任务知识库**在开源侧是空白——若 Nezha 要做接缝账本，没有现成可抄的实现。

---

## 6. 一句话结论

「一个聊天框自动知道任务该去哪个项目」**在 2026-09 的市面上不存在**，且 Paseo 明确拒绝了多仓库（PR #1461 / #1972 / #1530 / #2174 全部关闭）。市面能给的只有两件事：**多 repo workspace 的并行执行**（Vibe Kanban 最佳）和**组织级知识库**（厂商侧）。**跨仓库的协同语义（接缝、契约传播、联调验收）是公开记录里的真空地带**——这既是难点，也是 Nezha 做这件事的机会所在。
