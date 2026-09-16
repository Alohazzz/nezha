# 调研：知识图谱消费侧读取路径与新鲜度实测（2026-09）

> 目的：回答 issue [`.scratch/knowledge-auto-sedimentation/issues/02-consumption-freshness.md`](../../.scratch/knowledge-auto-sedimentation/issues/02-consumption-freshness.md) —— 「每个消费方各自从哪读图谱、读出的是哪一份、陈旧从哪里进入？」
> 结论先行：**陈旧有三个彼此独立的入口，必须分开修**——
> 1. **Hub 落后 origin**：SkillHub checkout 只在 Nezha **启动时**做一次 `fetch` + `ff-only pull`，跑任务前不拉（`skills.rs:1075` / `lib.rs:309`）；
> 2. **`data/index.md` / `data/graph.json` 不随卡片写入重建**：自动回写与手工增删卡片都只动 `data/modules/*.md`，index 只在人工点「扫描」时才重建（`knowledge.rs:800`、`KnowledgeGraphPanel.tsx:188`）——本机已有实证漂移（`Nto.Api.OnLinePay` 在盘不在索引）；
> 3. **HIS / ICUCIS 图谱已不可重建**：`graph.toml` 声明的 adapter（`his` / `icucis`）在 hub 里已被删除，只剩 `dotnet.py`，因此这两个图谱的「扫描」按钮永久禁用（`knowledge.rs:195`）；`EMR` 连 `graph.toml` 都没有，Nezha 根本看不到。
> 调研方法：一手来源优先——Nezha 源码（`src-tauri/src/`）、SkillHub 实际 checkout 的只读 `git` 命令、图谱数据文件、已安装技能软链与 `~/.nezha/*.json` 实况。
> 核查时间基准：2026-09-16 16:3x（本机）。

---

## 0. 事实底座（实测）

| 事实 | 值 | 证据 |
|---|---|---|
| Hub 路径 | `C:\Users\SuYi\.nezha\skill_repos\codeup.aliyun.com-641881e9b9581d62e8f8186e-HSP-SkillHub.git` | `~/.nezha/skill_hub.json` 的 `hubPath` |
| Hub 来源类型 | `git`（远端 `https://codeup.aliyun.com/641881e9b9581d62e8f8186e/HSP/SkillHub.git`） | 同上 `source.sourceType = "git"` |
| 本地 HEAD | `90e8dfc`（2026-09-15 15:26:12 +0800，本地 commit） | `git -C <hub> log -1` |
| 本地 `origin/master` | `90e8dfc`（与 HEAD 相同） | `git -C <hub> log -1 origin/master`；`git rev-list --count HEAD..origin/master` = **0** |
| 远端真实 HEAD | `5c3565a` —— **本机不认识这个对象** | `git -C <hub> ls-remote origin` 返回 `5c3565a...`；`git cat-file -t 5c3565a` → `fatal: Not a valid object name` |
| 上次 fetch 时间 | 2026-09-16 10:00（`FETCH_HEAD` mtime），内容仍是 `90e8dfc` | `ls -la <hub>/.git/FETCH_HEAD`；文件内容 |
| `lastSyncedAt` / `lastSyncedCommit` | 2026-09-16 10:00:16 / `90e8dfc` | `~/.nezha/skill_hub.json` |
| Clone 深度 | `--depth 1`（shallow） | `git rev-parse --is-shallow-repository` → `true`；`skills.rs:930` |
| 工作树脏状态 | 干净（0 行） | `git -C <hub> status --porcelain` |
| 图谱 | `HIS`(adapter `his`)、`ICUCIS`(adapter `icucis`)、`MessagePlatform`(adapter `dotnet`)、`EMR`(**无 `graph.toml`**) | `knowledge-graphs/*/graph.toml`；`ls knowledge-graphs/EMR/` |
| 可用 adapter | **只有 `dotnet.py`** | `git -C <hub> ls-files knowledge-graph/adapters/` → `dotnet.py`、`registry.toml` |

> **Hub 是否落后？** 实测本机 HEAD 与本地 `origin/master` 相等，而远端真实 HEAD 是 `5c3565a`（本机无此对象）。因为 clone 是 `--depth 1` 且上次 fetch 在 09-16 10:00，**只要 10:00 之后有人 push，本机 `origin/master` 就是过期的旧 ref、远端 HEAD 就是本机拿不到的对象**——这正是「本地看起来没落后、实际已落后」的形态。本报告无法只靠本机对象库算出落后几个 commit（缺 `5c3565a` 的祖先链），只能证实「远端已有本机没有的 commit」。

---

## 1. 主表：消费方 → 实际读的路径 → 陈旧源

| # | 消费方 | 实际读的路径（绝对/相对） | 触发方式 | 陈旧源 | 证据 |
|---|---|---|---|---|---|
| 1 | **Claude Code / Codex agent（跑任务时）** | 经技能自解析：`hub/knowledge-graph/scripts|adapters`（脚本）+ `hub/knowledge-graphs/<graph_id>/data/index.md` → `data/modules/<module>.md` | **prompt 注入技能名**，agent 自行触发技能 | Hub checkout 落后 origin（只在启动时 pull） | `agent_assist.rs:611`、`knowledge-graph/SKILL.md:25-26` |
| 2 | 同上，方案讨论链路 | 同上（技能内「前置知识认知」节） | prompt 注入 `yunxiao-plan-discussion`，其 SKILL.md 第 72 行再要求调 `knowledge-graph` | 同 1 | `agent_assist.rs:555`、`yunxiao-plan-discussion/SKILL.md:72` |
| 3 | 同上，方案执行链路 | 同上 | prompt 注入 `knowledge-graph` 技能名 | 同 1 | `agent_assist.rs:611`+`:650-662`；commit `3520684` |
| 4 | 同上，直接执行链路 | 同上 | 同上 | 同 1 | `agent_assist.rs:758` |
| 5 | **知识沉淀提取（headless agent）** | prompt 里显式给出 `knowledge_target.skill_dir` 与 `data_dir` 绝对路径 | Nezha 主动 headless 调用，cwd = 项目根 | 同 1（路径指向同一个 hub） | `agent_assist.rs:1462-1490`、`:1481-1484`、`:1703-1712` |
| 6 | **质量门 headless agent** | `{skill_dir}/SKILL.md` + `{graph_id}/data/modules/<module>.md`；**cwd = hub 根** | Nezha 主动调用 | 同 1 | `knowledge.rs:728-764`、`:814-818`、`:851-858` |
| 7 | **Nezha 右侧「知识库」面板** | `hub/knowledge-graphs/<graph_id>/data/modules/*.md`（**实时读盘，无缓存**） | 面板挂载 / 手动刷新 / 发布后 | 无（实时） | `knowledge.rs:407-438`、`KnowledgePanel.tsx:56-86` |
| 8 | **Nezha 主窗体打开卡片** | 同上，`read_knowledge_card_content` 实时读盘 | 点卡片 | 无（实时） | `knowledge.rs:443-452`、`FileViewer.tsx:248` |
| 9 | **Nezha 知识库设置面板（扫描/新建/改名/删除）** | 同上 + `data/index.md`、`data/graph.json`（仅作 pending 标记） | 用户点按钮 | **index.md / graph.json 只在点「扫描」时重建** | `KnowledgeGraphPanel.tsx:127-139`、`:188`、`:206-208`、`:224` |
| 10 | **自动回写（`knowledge_auto_writeback`）** | 只 append 到 `data/modules/<module>.md`；**完全不碰 index.md / graph.json** | 云端议题创建成功后自动跑 | 产出侧漂移：index.md 不反映新知识 | `knowledge.rs:800-984`（写入在 `:911-915`，提交 `:925-975`，无 index 重建） |
| 11 | **手工发布（`publish_knowledge_changes`）** | 只 `git add/commit/push` 调用方给的 `data/modules/*.md` 路径 | 面板「提交并推送」 | 同上 | `knowledge.rs:545-619`、`KnowledgePanel.tsx:102-106` |
| 12 | `data/graph.json` | **当前没有任何活消费方** —— 仅 `bootstrap.py --mode skeleton` 写空骨架、`dotnet.py` 全量重建；Nezha 不读，技能 SKILL.md 也不读 | — | 长期不更新（HIS 停在 2026-09-04） | `bootstrap.py:24-26`、`dotnet.py:439`；全仓 grep 无其他读者 |
| 13 | `data/index.md` | agent（技能第 1 步定位模块）+ Nezha 只把它当待提交文件 | agent 读；Nezha 不解析 | 同上（不随卡片写入重建） | `knowledge-graph/SKILL.md:25`；`KnowledgeGraphPanel.tsx:133` |

---

## 2. Agent 侧：怎么发现图谱、实际能不能读到

### 2.1 技能怎么装、装到哪

Nezha 把 skill 目录以 **symlink（Windows 优先 symlink，无权限时 junction）** 链接到技能根：

- 用户级根：`~/.codex/skills` 或 `~/.claude/skills`（`skills.rs:182-190`）
- 项目级根：`<项目>/.codex/skills` 或 `<项目>/.claude/skills`（`skills.rs:173-179`）
- 创建逻辑：`create_symlink` → Windows 失败回退 `create_junction`（`skills.rs:534-560`）
- 安装入口：`install_skill`（`skills.rs:1793`），落点选择在 `skills.rs:1868`（用户级）/ `:1882`（项目级）

**本机实际安装（`~/.nezha/skill_installations.json`）：**

| 技能 | scope | agent | link_path → target |
|---|---|---|---|
| `knowledge-graph` | universal | codex | `C:\Users\SuYi\.codex\skills\knowledge-graph` → `<hub>\knowledge-graph` |
| `his-knowledge-graph` | project (`1781168715666` = HIS) | codex | `H:\Project\Company\HIS\.codex\skills\his-knowledge-graph` → `<hub>\his-knowledge-graph`（**该目录现在只剩空 `scripts/`**） |
| `yunxiao-plan-discussion` | project | codex | `H:\Project\Company\HIS\.codex\skills\yunxiao-plan-discussion` → hub |
| `yunxiao-backfill-issue` | project | codex | HIS 项目级 |
| `issue-value-scoring` / `hsp-build-order` / `weekly-report` / `merge-code-review` / `batch-grill-me` / `archify` | universal | codex | `~/.codex/skills/*` |

关键事实（实况核对）：

- **`~/.claude/skills/` 里没有任何知识图谱相关技能**（`ls | grep -i knowledge\|graph` 为空）。即：**只有 Codex 侧装了 `knowledge-graph`，Claude Code 侧一个都没装**。项目里用 Claude 跑任务且落在用户级技能根的 agent 拿不到这个技能。
- `H:\Project\Company\HIS\.codex\skills\` 有 3 个链接；`H:\Project\Company\HIS\.claude\skills\` 只有 `yunxiao-plan-discussion` 一个。
- `H:\Project\nezha-main\.codex\skills\` 只有本地项目技能 `nezha-build-launch`——nezha 项目自身**未**装 `knowledge-graph`，且 `.nezha/config.toml` 的 `[knowledge]` 段缺失/为空（`graph_id` 未绑定）。

### 2.2 图谱数据对 agent 是否可达

**可达性由 SKILL.md 的路径约定兜住，不依赖 cwd**：技能明确要求「先解析符号链接，再取上一级」作为技能库根目录，并校验该根下同时存在 `knowledge-graph/` 与 `knowledge-graphs/<id>/`（`knowledge-graph/SKILL.md:11-15`）。所以即使任务 cwd 是业务项目根甚至 worktree，agent 只要顺链接解析就能找到 `<hub>/knowledge-graphs/<graph_id>/data/`。

**但 `graph_id` 的解析在 worktree 场景会掉**：技能第 19 行说「项目配置中的 `knowledge.graph_id` 是唯一图谱身份」（`SKILL.md:19-21`），而配置读取路径是 `<cwd>/.nezha/config.toml`（`config.rs:162-171`）。worktree 任务的实际 cwd 是 `task.worktreePath`（`App.tsx:1420-1424`、`:1431`），而 `create_task_worktree`（`git.rs:1910-1958`）只用 `git worktree add` 建检出，**不会把 `.nezha/config.toml` 复制/链接进去**（`git.rs` 全文无此逻辑），且 `.nezha` 在业务仓是 gitignore 的（`H:\Project\Company\HIS\.gitignore:337` `/.nezha`）。→ **worktree 任务里 agent 按「项目配置」找不到 `graph_id`**（真实根只通过 `real_project_path` 传给后端用于收拢草稿，`pty.rs:960-969`、`:217-224`，不进 prompt）。

**prompt 侧只注入技能名，不注入图谱 id**，这是有意设计（`agent_assist.rs:609-611` 注释：图谱选择由技能按项目配置自行解析，不在此注入具体图谱 id；测试也断言「图谱 id 不能被当成技能名」，`agent_assist.rs:1746-1748`）。所以 agent 侧的图谱定位**完全依赖技能触发 + 技能自己解析配置**。

### 2.3 是 prompt 注入还是技能自动触发？

**两者都有，且 prompt 注入是主路径**（技能靠 `description` 自动触发不可靠）：

| 注入点 | 常量 / 位置 | 文本要点 |
|---|---|---|
| 方案讨论 | `agent_assist.rs:555`（经 `plan_discussion_instructions`） | 只注入 `yunxiao-plan-discussion` 技能名；该技能 SKILL.md:72 再要求调 `knowledge-graph` |
| 方案执行 | `agent_assist.rs:611` `PLAN_KNOWLEDGE_INSTRUCTION`，拼装在 `:650-662` | 「另外，开始前先使用 knowledge-graph 技能…」（commit `3520684`） |
| 直接执行 | `agent_assist.rs:758`（`pieces.push(PLAN_KNOWLEDGE_INSTRUCTION)`) | 同上 |
| 知识沉淀提取 | `agent_assist.rs:1462-1490` | 直接给出 `技能目录：{graph_skill_dir}` / `{graph_data_dir}`，并要求「先读取技能目录下的 SKILL.md，再按数据目录查询图谱」（`:1484`） |
| 质量门 | `knowledge.rs:748-763` | 「请先读取并严格遵循 `{skill_dir}/SKILL.md`…」，cwd 设为技能目录 |

结论：**agent 读图谱是 prompt 驱动的确定性路径**（讨论→技能内章节、执行→直接注入、沉淀/质量门→headless 显式给绝对路径），不是「等技能自己触发」。

---

## 3. `data/index.md` 与 `data/graph.json` 各自驱动什么、谁生成、何时重建

### 3.1 驱动关系

- **`index.md`：唯一活消费方是 agent**。`knowledge-graph/SKILL.md:25` 第 1 步就是「读取 `…/data/index.md` 定位模块或业务域」，第 2 步才打开 `modules/<module>.md`（`:26`）。Nezha 前端不解析它，只把它列为「待提交文件」（`KnowledgeGraphPanel.tsx:133`）。
- **`graph.json`：当前没有活消费方**。全 hub grep 只有 `bootstrap.py:24`（骨架写空）与 `adapters/dotnet.py:439`（全量重建）会写它；没有任何脚本/技能/Nezha 代码读它。它的定位是「机器可读图谱（模块节点 + 跨模块依赖边）」（`dotnet.py:16-17`），但目前**没有机器在读**。
- 依赖边只有 `index.md` 里被截断展示前 40 条（`dotnet.py:475-481`），完整边在 `graph.json` —— 而指向 `graph.json` 的文本本身就在 `index.md` 里（`HIS/data/index.md:241`）。

### 3.2 谁生成

| 产物 | 生成者 | mode | 行为 |
|---|---|---|---|
| `index.md` / `graph.json` / `_template.md` 空骨架 | `bootstrap.py` | `--mode skeleton` | 仅在文件**不存在**时写（`bootstrap.py:15-26`） |
| `index.md` / `graph.json` 全量内容 | `bootstrap.py --mode scan` → 转交 adapter（`bootstrap.py:44-50`） | `scan` | `dotnet.py` **无条件覆盖** `graph.json`（`:439`）与 `index.md`（`:484`），但 `modules/*.md` **只新建缺失、绝不覆盖**（`:441-449`） |

Nezha 侧触发 `scan` 的**唯一入口**是 `scan_knowledge_graph`（`knowledge.rs:363-395`），它跑
`python <skill_dir>/scripts/bootstrap.py --adapter <adapter> --repo <project> --data-dir <graph.data_dir> --mode scan`
（`knowledge.rs:373-382`），前端在设置面板「扫描」按钮调用（`KnowledgeGraphPanel.tsx:127`），并且按钮在 `!graph.ready || !graph.scanAvailable` 时禁用（`:369`）。

注意 Nezha 的 `initialize_knowledge_graph` **不跑 bootstrap skeleton**，而是 Rust 内部硬编码同一套骨架内容（`knowledge.rs:341-352`，模板常量在 `:85`）。

### 3.3 内容变化后是否重建？—— 否

`knowledge_auto_writeback`（`knowledge.rs:800-984`）的完整写入链路是：

1. 规则层校验（`:820-846`）→ 2. headless 质量门（`:848-890`）→ 3. **只对 `data/modules/<module>.md` 做 `append_entry` 尾部追加**（`:911-915`，`append_entry` 定义在 `:767-796`）→ 4. `git add <changed modules>` / `commit` / `push`（`:925-975`）。

**全程没有 index.md / graph.json 的读取或重写**——`knowledge.rs` 里 `index.md` / `graph.json` 只出现在 `initialize_knowledge_graph` 的骨架创建处（`:345`、`:349`）。手工 `publish_knowledge_changes` 同样只提交调用方给的路径（`:545-619`）。

**实证漂移（本机）**：

```
<hub>/knowledge-graphs/HIS/data/modules/   共 101 个 .md
<hub>/knowledge-graphs/HIS/data/index.md   只列出 100 个
  → 盘上有、索引无：Nto.Api.OnLinePay
```

（复现命令：`ls modules | sed 's/\.md$//' | sort` 与 `grep -o 'modules/[^)]*\.md' index.md | sed …` 做 `comm`。）

`HIS/data/index.md:1` 的生成时间是 **2026-09-04 15:45**，`graph.json:2` 的 `generated_at` 同为 `2026-09-04 15:45`；而 HIS 模块卡片此后仍有 2026-09-07/09-08 的提交（`git log -- knowledge-graphs/HIS/data/modules` → `89134af` 2026-09-08 等）。**index.md 落后卡片 4 天，且新卡片 `Nto.Api.OnLinePay` 永久缺失**。

漂移的成因（代码级）：设置面板 `createCard` / `renameCard` / `deleteCard` 只把**卡片自身**加入 pending，**不把 `index.md` 加入 pending**（`KnowledgeGraphPanel.tsx:188`、`:206-208`、`:224`）；只有 `scan` 才追加 `"data/index.md", "data/graph.json"`（`:133`）。自动回写更极端——连 pending 都不经过前端（`App.tsx:2904-2915`），直接 commit 模块卡片。

### 3.4 HIS / ICUCIS 的图谱已经不可重建

`graph.toml` 声明的 adapter 与现存 adapter 对不上：

| 图谱 | `graph.toml` adapter | adapter 文件是否存在 | `scan_available` |
|---|---|---|---|
| HIS | `his` | ✗（`dcfc5d4` 已删除 `adapters/his.py`） | **false** → 扫描按钮永久禁用 |
| ICUCIS | `icucis` | ✗（同 commit 删除 `adapters/icucis.py`） | **false** |
| MessagePlatform | `dotnet` | ✓ `adapters/dotnet.py` | true |
| EMR | **无 `graph.toml`** | — | 不在 `list_knowledge_targets` 结果里 |

证据：`knowledge.rs:194-199` 的 `scan_available` 要求 `<hub>/knowledge-graph/adapters/<adapter>.py` 存在；`git -C <hub> ls-files knowledge-graph/adapters/` 只有 `dotnet.py`、`registry.toml`；`9d5dfab`「drop retired his/icucis ids from adapter registry」后 `registry.toml` 只剩 `dotnet`。`list_knowledge_targets_internal` 要求目录下必须有 `graph.toml` 才收录（`knowledge.rs:176-179`），因此 EMR 的 7 张卡片对 Nezha 完全不可见（`knowledge-graphs/EMR/data/` 里有 `index.md`/`graph.json`/7 个模块，但无 `graph.toml`）。

→ 即便用户想「重建索引」，HIS / ICUCIS 在 Nezha 里做不到；EMR 连绑定都绑不了。

---

## 4. Hub 是否落后 origin；Nezha 何时 pull

### 4.1 会不会落后：会

Hub 是标准浅克隆（`skills.rs:930` `clone --depth 1`），`~/.nezha/skill_hub.json` 记录了 `lastSyncedAt` / `lastSyncedCommit` / `lastSyncError`（`skills.rs:38-54`）。任何**他人 push 之后**，本机要等一次 `fetch` + `ff-only pull` 才看得到。

### 4.2 Nezha 何时 pull —— 只有两个入口

| 入口 | 位置 | 时机 | 说明 |
|---|---|---|---|
| **应用启动后台同步** | `lib.rs:308-311` → `skills::startup_sync`（`skills.rs:1075-1084`） | 每次 Nezha 启动一次 | 仅当 `source.sourceType == "git"`；失败静默沿用缓存（`:1081`），完成后 emit `skill-hub-changed` |
| **用户手动点「同步」** | `skills.rs:1346-1349` `sync_skill_source` 命令；前端 `SkillHubView.tsx:90` | 用户在技能库视图点按钮 | 返回含 `lastSyncError` 的配置 |

`sync_git_repo` 的实际动作（`skills.rs:878-1010`）：`.git` 不存在 → shallow clone；否则**先恢复被删除的跟踪文件**（`restore_deleted_tracked_files`，`:809-848`）→ `git fetch origin`（`:949-958`）→ 比较 `HEAD` 与 `FETCH_HEAD`（`:965-990`）→ **不同才** `ff_only_update`（`git pull --no-rebase --ff-only`，`:854-874`）。

**不存在任何跑任务前的 pull、也不存在定时轮询**：全仓 grep 无 `tokio::time::interval`；`startup_sync` 只有 `lib.rs:310` 一个调用点；`pty.rs`（任务启动路径）完全不引用 skills/hub/graph。任务真正启动前的知识链路里没有任何「先同步技能库」的步骤。

### 4.3 写入侧写前不 pull（放大冲突与落后）

`knowledge_auto_writeback` 与 `publish_knowledge_changes` 的 git 序列是 `add → commit → push`，`push` **不带 remote/branch**（`knowledge.rs:962-967`、`:606-611`），且**写前没有 fetch/pull**。因为 hub clone 是 shallow 且本地是 master 直提，只要远端领先就会出现 non-fast-forward，结果落到错误分支「已提交但推送失败…（本地提交已保留，可手动 push 后关闭议题）」（`knowledge.rs:968-973`）。本机 hub 的 reflog 也确实显示本地直接 `commit`（`90e8dfc`、`687fa26` 等）而非 rebase 合并——即**这个仓库既被当「远端缓存」又被当「本地工作副本」**。

### 4.4 「落后」的可观测盲区

`list_modified_knowledge_cards`（`knowledge.rs:457-493`）用的是 `git status --porcelain -- data/modules`，即**相对 HEAD 的未提交改动**；它不比对 `origin`，所以**「本地已提交但未推送」「远端领先本地」都检测不到**，面板上不会出现任何「落后」提示。前端唯一的状态展示是 `SkillHubView` 的同步时间/错误（消费 `SkillHubConfig`）。

---

## 5. Nezha 自己的知识面板：读的是不是实时文件？有没有缓存？

### 5.1 后端：全部实时读盘，无缓存

| 命令 | 读取实现 | 缓存 |
|---|---|---|
| `list_knowledge_cards` | `std::fs::read_dir(<data_dir>/modules)` + 逐文件 `read_to_string`（`knowledge.rs:416-432`） | 无 |
| `read_knowledge_card_content` | `resolve_knowledge_target` → `module_card_path` → `fs::read_to_string`（`knowledge.rs:443-452`），且每次调用都重新 `list_knowledge_targets_internal()` 扫盘解析（`:216-228` → `:159-213`） | 无（每次重新解析 hub + 读 `graph.toml`） |
| `list_modified_knowledge_cards` | `git status --porcelain` 实跑（`knowledge.rs:459-469`） | 无 |
| `list_knowledge_targets` / `list_knowledge_graph_adapters` | 每次 `read_dir` hub（`knowledge.rs:172`、`:97`） | 无 |

也就是说：**只要磁盘上的 `modules/*.md` 变了，后端下次调用立刻看到**（无论变更是本机 Nezha 写的、还是别人 push 后本机 pull 下来的）。

### 5.2 前端：有会话内缓存，且不监听 hub 变更事件

- `KnowledgePanel.tsx:56-86` 的 `refresh()` 在 **`useEffect([refresh])` 即面板挂载时**跑一次（`:84-86`），另外只在**手动点刷新**（`:123-131`）和**发布后**（`:109`）重跑。
- **没有 `listen("skill-hub-changed")`**（全文件无 `listen`；`skill-hub-changed` 的监听只在 `SkillHubView.tsx:71`）。→ 后台启动同步/手动同步拉下新图谱后，**已打开的知识库面板不会自动刷新**。
- 面板组件在 `rightPanel === "knowledge"` 时才挂载（`ProjectPage.tsx:1481-1489`），关掉再开即重新拉取——所以实际 lag 上限是「面板保持打开 + 没人点刷新」的任意时长。
- 打开卡片走 `read_knowledge_card_content`（`FileViewer.tsx:248`），依赖 `[filePath, projectPath, isPreviewableImage, knowledge, module]`，**同一个 module 再次打开不会重读**（依赖未变）；编辑器有 1500ms 防抖保存（`FileViewer.tsx:291-300`）。

---

## 6. 其他消费方（逐个列出假设的路径）

| 消费方 | 是否读图谱 | 证据 |
|---|---|---|
| `yunxiao-plan-discussion` | **是**。SKILL.md「前置知识认知」节要求调 `knowledge-graph` 查「本项目绑定的知识图谱」，未绑定则跳过 | `yunxiao-plan-discussion/SKILL.md:72` |
| `knowledge-graph`（质量门角色） | **是**。SKILL.md「回写质量门」节被 `build_gate_prompt` 直接引用为规则源 | `knowledge-graph/SKILL.md:39-50`、`knowledge.rs:749` |
| `knowledge-graph`（初始化/扫描角色） | **是**。脚本路径 `knowledge-graph/scripts/bootstrap.py` + `knowledge-graphs/<graph-id>` | `knowledge-graph/SKILL.md:31-37` |
| `his-knowledge-graph`（旧技能） | **空壳**。目录只剩 `scripts/`，无 SKILL.md；HIS 项目仍挂着这个已死的 junction | `H:\Project\Company\HIS\.codex\skills\his-knowledge-graph`；`skill_installations.json` |
| `icucis-knowledge-graph` | 同样只剩空 `scripts/`；但**未安装到任何技能根**（安装表里无此项） | `<hub>/icucis-knowledge-graph/` |
| `yunxiao-backfill-issue` | 不读图谱（只产议题） | 该技能全部文件内 grep `图谱`/`knowledge-graph` 命中 0 |
| `hsp-build-order` | 不读图谱 | 同上，命中 0 |
| `weekly-report` | 不读图谱 | 同上，命中 0 |
| `issue-value-scoring` | 不读图谱 | 同上，命中 0 |
| `batch-grill-me` | 不读图谱 | 同上，命中 0 |
| Nezha 前端 `KnowledgePanel` / `KnowledgeGraphPanel` / `FileViewer` | 读 `data/modules/*.md`（见第 5 节）；**不读 `index.md` / `graph.json` 内容** | `KnowledgePanel.tsx:69`、`KnowledgeGraphPanel.tsx:79` |
| Nezha 页面 `knowledge-graph/agents/openai.yaml` | 遗留的 agent 附加配置，`default_prompt` 仍指向 `$his-knowledge-graph`（死技能名） | `<hub>/knowledge-graph/agents/openai.yaml:4` |

---

## 7. 具体滞后点（谁看到旧数据、为什么、最多滞后多久）

### 滞后点 A — Hub checkout 落后 origin（影响所有 agent 读取）
- **谁看到旧数据**：所有跑任务的 agent（Codex 与 Claude，只要装了 `knowledge-graph` 技能的都读同一份 hub）；也包括 Nezha 的质量门 headless 调用（cwd = hub 根）。
- **为什么**：只在 Nezha **启动时**做一次 `fetch` + `ff-only pull`（`skills.rs:1075-1084`，`lib.rs:308-311`），**跑任务前不 pull、无定时拉取**；任务启动路径（`pty.rs`）完全不碰 hub。
- **滞后时长**：从「别人 push」到「本机下次启动 Nezha 或用户手点同步」；实测形态为远端已有 `5c3565a`、本机 `origin/master` 仍停在 `90e8dfc`，且 `lastSyncedAt = 2026-09-16 10:00`。**若 Nezha 常驻不重启，滞后可以无限长。**
- **可修在哪**：**Nezha 侧**（跑任务前/按需轻量 `fetch` + 落后检测提示），或 hub 侧（约定 push 后广播）。落后检测当前完全缺失。

### 滞后点 B — `data/index.md` 不随卡片写入重建（agent 定位模块失效）
- **谁看到旧数据**：agent —— 技能第 1 步用 `index.md` 定位模块（`knowledge-graph/SKILL.md:25`）。缺失的模块永远不会被 `index.md` 指到，只能靠 agent 自己兜底。
- **为什么**：自动回写与手工增删卡片都只写/提交 `data/modules/*.md`（`knowledge.rs:911-915`、`KnowledgeGraphPanel.tsx:188`），**没有任何 index 重建步骤**；且 HIS/ICUCIS 连「扫描」都跑不了（见滞后点 C）。
- **滞后时长**：**永久**（直到有人手动重建）。实证：`Nto.Api.OnLinePay` 在盘不在索引；HIS `index.md` 的 `generated_at` 停在 2026-09-04，落后 4 天以上。
- **可修在哪**：**Nezha 侧**（回写成功后顺带重建/追加 index 条目）**或 hub 侧**（把 index 降级为「可整体重建的产物」并在写入流程里调用）。`graph.json` 同理但无人消费，优先级低。

### 滞后点 C — HIS / ICUCIS 图谱在 Nezha 内不可重建
- **谁看到旧数据**：所有 HIS / ICUCIS 项目下的 agent（`H:\Project\Company\HIS\.nezha\config.toml` 的 `graph_id = "HIS"`）。
- **为什么**：`graph.toml` 的 adapter 指向已删除的 `his.py` / `icucis.py`，`scan_available=false`（`knowledge.rs:194-199`），扫描按钮禁用（`KnowledgeGraphPanel.tsx:369`）；EMR 无 `graph.toml`，完全不可见（`knowledge.rs:176-179`）。
- **滞后时长**：**永久**。
- **可修在哪**：**hub 侧**（把 HIS/ICUCIS 的 `graph.toml` 迁到 `dotnet` adapter，或恢复专用 adapter；给 EMR 补 `graph.toml`）。Nezha 侧最多只能给出更明确的错误提示。

### 滞后点 D — worktree 任务里 agent 读不到 `knowledge.graph_id`
- **谁看到旧数据 / 读不到数据**：启用 worktree 的任务（cwd = `task.worktreePath`）。
- **为什么**：`run_task` 的 cwd 是 worktree（`App.tsx:1420-1424`）；`create_task_worktree` 不复制 `.nezha/config.toml`（`git.rs:1910-1958`），`.nezha` 也被业务仓 gitignore（`HIS/.gitignore:337`）。技能第 19 行从「项目配置」取 `graph_id`（`SKILL.md:19-21`），而配置读的是 `<cwd>/.nezha/config.toml`（`config.rs:162-171`）。
- **滞后时长**：不适用（是**读不到**而非读到旧）；表现为技能解析不到图谱 → 按「未绑定」跳过，或回退到猜模块（SKILL.md 明令禁止）。
- **可修在哪**：**Nezha 侧**（把 `graph_id` 注入 prompt 或 worktree 环境变量，或在 worktree 里补一份配置链接）。注意 `agent_assist.rs:1746-1748` 的测试明确禁止把图谱 id 当技能名注入，若要注入需与那次设计决策对齐。

### 滞后点 E — 面板不监听 hub 变更事件
- **谁看到旧数据**：右侧「知识库」面板的卡片列表。
- **为什么**：`KnowledgePanel` 只在挂载 / 手动刷新 / 发布后刷新（`KnowledgePanel.tsx:56-86`、`:123-131`），无 `listen("skill-hub-changed")`（对比 `SkillHubView.tsx:71`）。
- **滞后时长**：面板保持打开期间**无限**。
- **可修在哪**：**Nezha 侧**（加一个监听即可；后端已在同步完成后 emit，`skills.rs:1083`）。

### 滞后点 F — 写入侧 push 不指定 remote/branch、写前不 pull
- **谁受影响**：自动回写与手工发布本身（不是读取方，但会让「本地已写、远端/其他机器看不到」持续存在）。
- **为什么**：`knowledge.rs:962-967`、`:606-611` 的 `vec!["push"]` 假定 upstream 存在；写前无 fetch/pull，且 hub 是 shallow 本地直提仓库（reflog 显示本地 `commit`）。
- **滞后时长**：push 失败时直到有人手动 push——而面板**检测不到「已提交未推送」**（`list_modified_knowledge_cards` 只看相对 HEAD 的脏状态，`knowledge.rs:459-469`）。
- **可修在哪**：**Nezha 侧**（改成 `push origin <branch>` + 写前 fetch/落后检测 + 前端展示 ahead/behind）。

---

## 8. 一句话版本

- **要「每次都调到最新」**，真正的堵点是 **滞后点 A（hub 不拉）+ B（index 不重建）**，两者都在 Nezha 侧可修；
- **滞后点 C（HIS/ICUCIS adapter 已删）** 是 hub 侧的历史遗留，Nezha 修不了；
- **滞后点 D（worktree 拿不到 graph_id）** 是当前最可能让 agent「静默不用图谱」的一条路径，值得单独确认复现；
- `graph.json` 目前是**无人消费的死产物**，把它列进「新鲜度」议题只会增加噪音。
