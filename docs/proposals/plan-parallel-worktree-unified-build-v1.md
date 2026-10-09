# 方案并行执行（worktree 并行 × 滚动合并 × 增量统一构建）— 需求文档 v1

> **状态：评估中（未批准实施）**。本文档沉淀 2026-09-29 的方案讨论共识，供后续讨论与风险评估。
> 按 nezha 的 issue-first 规范，实施前仍需单独提提案 issue。目前**未提 issue、未写任何代码**。

## 1. 背景与动机

HIS 项目（`H:\Project\Company\HIS`）使用 nezha 的「方案」功能批量下发议题任务（如 QHDK-30486/30480/30487 一批三条、互相无依赖）。当前执行链是**纯串行**：

- 调度根源：`src/App.tsx:291` 的 `DEFAULT_PLAN_MAX_CONCURRENT = 1`——同一项目同时只放行一个任务；
- 调度器本身（`src/utils/planQueue.ts::selectAutoStart`）已有「拓扑序 + 空闲槽位」机制，串行只是槽位上限的默认值。

串行执行一批 N 个无依赖议题的耗时 ≈ N × 单任务耗时，效率瓶颈明显。期望：无依赖任务**并行**执行、done 后**滚动合并**回主检出、全部合并后做一次**增量统一构建**，产物经现有链路流入共享目录 `H:\Project\Company\可执行程序`。

## 2. 调研结论（事实基础，已实地证实）

### 2.1 nezha 侧

| # | 事实 | 证据 |
|---|------|------|
| F1 | 方案→待办的任务显式「跑在当前工作区」，不带 worktree 字段 | `App.tsx` `handleGeneratePlanTodos`（约 :2555-2570） |
| F2 | worktree 原语齐备：create / merge / remove / diff-stats | `src-tauri/src/git.rs:1980/2081/2168/2212` |
| F3 | `create_task_worktree` **不初始化子模块** | `git.rs:1980` 实现仅 `git worktree add` |
| F4 | 合并 UX 是手动按钮；冲突只有报错字符串 + 人工处理 | `RunningView.tsx:499-528`、`git.rs:2137-2141` |
| F5 | 冲突后端命令已注册但前端零调用（`get_conflict_context` 等） | `git.rs:2611/2642`、`lib.rs:559` |
| F6 | BuildPanel / `build.rs` 即为 HIS 定制（默认 `Hsp v2.0.sln`、子仓库白名单、增量基线、错误清单导出、`max_parallel=8`），但与方案执行零联动 | `build.rs:52/64/143` |
| F7 | 方案执行有无人值守模式；失败处理是「挂起等人工」（通知 + 标红），不静默跳过 | `App.tsx:2762-2779`、`planQueue.ts:55-57` |
| F8 | 前端架构限制：同时仅挂载 1 个 xterm 实例（WebGL context 限制），多并行任务只能靠列表状态 chip 可观测 | `ProjectPage.tsx:762-771` |

### 2.2 HIS 侧

| # | 事实 | 证据 |
|---|------|------|
| F9 | 主仓库（.git 597M、52k 文件、3.1G 工作区）+ 8 个子模块 + 1 个**未登记嵌套仓库 Hsp.Main**（有 gitlink 无 .gitmodules 条目，`submodule update` 会报错） | `git submodule status` 报错；`.gitmodules` |
| F10 | 431 项目 .sln、约 930 个 csproj，全部老式非 SDK 风格（net46x），OutputType = Library×481 / WinExe×25 | `Hsp v2.0.sln` |
| F11 | 497 个 csproj 的 OutputPath 相对路径直写共享目录 `H:\Project\Company\可执行程序\`；380 个 csproj 的 HintPath 又从**同一目录**读依赖 DLL（含兄弟项目成品 DLL）——「边读边写同一目录」自闭环；项目间基本无 ProjectReference | csproj 抽样（`Hsp.BaseData.Cache.Bll.csproj:20/24/37`） |
| F12 | 正式构建链 `Build\AutoBuild.bat → msbuild Build.proj`：274 项目、先暂存 `Build\<Config>\DLL` 再入共享目录；但 bat 是交互式、MSBuild 探测列表无 VS18 路径（本机实际 MSBuild 在 `D:\Program Files\Microsoft Visual Studio\18\Professional\...`） | `Build/Build.proj`、`AutoBuild.bat` |
| F13 | 共享目录非 git 管理、3.6G、被「构建 + 运行中程序」双写（调研当天 14:38 仍在被写） | 目录实测 |
| F14 | 主检出的子模块 gitlink 漂移（new commits）是团队常态；最近 69 个提交文件中 68 个在主仓库 | `git status`、`git log` 统计 |
| F15 | HIS 的 `.nezha/config.toml` 已配 `[worktree] base_path = 'H:\Project\Company\worktree'`——与主检出同相对深度，csproj 的 `..\..\..\..\可执行程序\` 相对路径在 worktree 中天然落到 `worktree\可执行程序\` 私有目录，不会穿透主共享目录 | config 实测 |
| F16 | 子模块 Term / DrugInOut 内部 csproj 与主仓库同构（OutputPath 同样汇聚共享目录），Build.proj 亦包含其项目 | `Nto.His/Nto.His.Term/**/*.csproj` 22 处 OutputPath |

### 2.3 关键风险（讨论中识别）

| # | 风险 | 应对（已纳入设计决策） |
|---|------|------|
| R-1 | worktree 内构建/agent 误写穿透到主共享目录 | nezha 统一包装 msbuild，强制 `/p:OutputPath` + DocumentationFile 双重定向（D3） |
| R-2 | HintPath 从 junction 目录读到「被并行任务写了一半」的 DLL | worktree 内构建只读借用 + 输出重定向（D3）；统一构建只在合并后单点执行（D9） |
| R-3 | 主检出滚动合并期间被用户手工操作（切分支 / 改文件） | 双闸门：脏检查（豁免 gitlink 漂移）+ 分支一致性断言（D7） |
| R-4 | 合并冲突打断滚动链、无人值守半路卡死 | 冲突自动生成修复任务，2 次失败降级挂起 + 通知（D8） |
| R-5 | 增量构建陈旧 DLL（接口变了、依赖方没重编） | 编译范围 = 方案 diff 映射工程 ∪ HintPath 引用方（D10）；残余风险不劣于 status quo |
| R-6 | 构建时 HIS 程序正在运行占文件锁 | 构建前 DLL 文件锁预检，提示先关程序（D9） |
| R-7 | agent 改了子模块文件，worktree 化后合并复杂度翻倍 | 任务级降级串行 + 合并互斥暂停（D12） |
| R-8 | 修复循环失控（构建失败→修→再败→…） | 自动修复上限 2 轮，超限挂起 + 通知，永不自动 revert（D11） |
| R-9 | **主检出上的自动化操作本身是最大风险源**。2026-09-29 实测演练中，一次「stash → merge → reset --hard → stash pop」的测试链因 reset 在 pop 之前执行，覆盖了用户未提交的 2 个文件改动且无法找回 | 立法级闸门：自动化在主检出上只允许 append 类操作（merge --no-ff / commit / checkout 分支），一切可能覆盖工作区的命令（reset --hard / clean / checkout -- <path>）列入禁令清单；测试与演练一律在临时 worktree 进行，永不在主检出跑破坏性命令链（新决策 D15） |

### 2.4 成本实测（2026-09-29，HIS 仓库本机实测）

| 环节 | 实测耗时 | 备注 |
|------|---------|------|
| `git worktree add`（主仓库 15020 跟踪文件） | **11.0 s** | 含 15020 文件检出 |
| 子模块初始化（4 个在用子模块，`--reference` 本地借用 + `protocol.file.allow=always`） | **6.2 s** | Hsp.Main 需白名单绕行；Nto.Report/Hsp.WebApi/Nto.PEIS/Nto.Pacs 主检出亦未初始化，无需处理 |
| 合并回主检出（fast-forward） | **0.2 s** | 无冲突场景 |
| worktree 移除 + 分支清理 | 秒级 | — |

**结论：git 层面的并行开销 ≈ 17 s/任务，相对 agent 任务几十分钟的耗时可忽略。** 并行的净收益主要取决于：任务数与单任务时长（收益 ∝ 两者乘积 / 并发数）、冲突修复的期望成本（滚动合并下单次 ≈ 一个小型 agent 任务）、以及统一构建尾部（串行同样需要，非并行额外成本）。按 3 个无依赖议题、单任务 30 min、并发 2 估算：串行 90 min → 并行约 60 min + 冲突预期 <5 min，净收益约 25-30%。任务批量越大收益越高；任务数 ≤2 时收益接近持平。

## 3. 需求目标（用户故事）

1. **并行**：作为用户，我下发一个含 N 个无依赖议题的方案后，希望多个任务同时跑（默认并发 2），总耗时从 N×T 降到约 ⌈N/并发数⌉×T。
2. **滚动合并**：任务 done 后自动 commit + merge 回主检出，下游依赖任务随即放行——全程无需我手动点合并按钮。
3. **统一构建**：方案全部合并完成后自动触发一次增量构建（只编译变更 DLL 及其引用方），产物经现有链路流入共享目录；构建失败自动生成修复任务（≤2 轮）。
4. **安全边界**：以上全自动流程绝不写入非预期目录（尤其共享目录）、绝不自动 revert / stash / 切分支；异常一律挂起 + 系统通知，等人工决策。
5. **可灰度**：新流程有项目级开关，默认关闭；开启前后的行为完全隔离。

## 4. 设计决策（讨论定案）

### 调度

- **D1** 并行语义：无依赖议题任务并行，有依赖按现有拓扑规则等待；同项目并发上限默认 **2**（项目 config 可调）。
- **D2** 开关：项目 config 新增 `[plan] parallel_execution`，**默认 off**；HIS dogfood 稳定后再议默认值。

### worktree 生命周期

- **D3** worktree 内构建轻检：nezha 统一包装 msbuild 调用，强制 `/p:OutputPath=<worktree>\.nezha-build\` 并同步重定向 DocumentationFile，**严禁写穿透到共享目录**；依赖 DLL 经 **NTFS junction** 只读借用主共享目录（零磁盘成本、依赖最新）。注意 junction 方向是「worktree 可执行程序 → 主共享目录」，运行时写操作（Log/Cache）也会穿透到主目录——评估时需复核此项（见 §7-开放问题）。
- **D4** 任务 done 时 worktree 有未提交改动 → 自动 commit（复用 `generate_commit_message`）再合并。
- **D5** worktree 创建时子模块**只读初始化**（`submodule update --init`，Hsp.Main 白名单绕行）；agent 改了子模块文件 → 合并时标记异常挂人工（v1 守卫）。

### 合并策略

- **D6** 滚动合并：done → 自动 commit → 立即 merge 回主检出 → 下游任务放行。合并目标 = **主检出当前分支**。
- **D7** 合并双闸门（不满足则暂停方案 + 通知，不自动处置）：
  - 脏检查：主检出**主仓库被跟踪文件**未提交修改 → 阻断；**子模块 gitlink 漂移豁免**（团队常态，仅警告一次）；
  - 分支一致性：主检出当前分支 ≠ 生成待办时记录的 baseBranch → 暂停（不自动切分支）。
- **D8** 合并冲突 → 自动生成冲突解决修复任务（两边 diff + 冲突文件清单拼进 prompt），连续失败 2 次降级挂起等人工；与构建修复共用「修复任务」基建。

### 统一构建

- **D9** 触发：方案内全部任务合并成功后自动触发一次，在主检出执行，复用 BuildPanel 命令层（`run_build` / `analyze_build`）；构建前做目标 DLL **文件锁预检**。
- **D10** 构建方式：**增量——只编译变更 DLL**。编译范围 = 本方案全部合并 diff 映射到的工程（`build.rs` 现有映射）**∪** HintPath 引用了这些工程输出 DLL 的工程（静态扫 csproj 枚举）。残余风险（反射等不可枚举引用方）与现状手工增量行为相同。（用户改判：全量 40+ 分钟太重，弃用全量。）
- **D11** 构建失败 → 自动生成修复任务（新 worktree、基于合并后主检出，prompt 带 `analyze_build` 错误清单 + 方案 diff 范围），「done→合并→重建」小循环**上限 2 轮**，超限整条方案挂起 + 通知。**不做自动 revert**。

### 子模块改动

- **D12** 任务级路由：生成待办时逐议题标注「涉及子仓库」（LLM 预标 + 手动可改）；涉子模块任务**降级跑主检出串行**（即今天的模式），其运行期间滚动合并**互斥暂停**；纯主仓库任务照常并行。子模块双层合并（merge 分支 + bump gitlink）留作 v2。

### 范围与分期

- **D13** 能力做成通用（nezha 原语 + 项目 config 驱动），HIS 专用只留在配置。
- **D14** 分期（每期独立可用、独立回退）：
  - **期 1（并行执行主体）**：PR① 调度并行化；PR② worktree 子模块只读初始化 + Hsp.Main 绕行 + 子模块改动守卫；PR③ 滚动合并编排（闸门 + 修复任务基建，无构建联动）。
  - **期 2（构建验证闭环）**：PR④ 统一构建联动（触发 + 锁预检 + 修复循环）+ worktree 轻检注入（junction + 双重定向）。
  - **期 3（子模块任务路由）**：PR⑤ 子模块任务级标注 + 串行降级 + 互斥暂停。
- **D15**（2026-09-29 事故后新增）**主检出操作禁令**：滚动合并的自动化在主检出上只允许 append 类 git 操作（merge、commit、log/diff/status 等只读命令）；`reset --hard`、`clean`、`checkout -- <path>`、`stash` 系列一律禁止进入自动化路径（stash 需要用户在场决策）。合并前置条件不满足时唯一动作是暂停 + 通知。所有测试/演练在临时 worktree 进行。

## 5. 明确不做（本期边界）

- 子模块的可写 worktree 化与双层自动合并（v2 演进）；
- 自动 revert、自动 stash 主检出、自动切分支；
- 终端级多任务同屏（可观测性靠列表状态 chip + 看板——架构限制一次只挂一个 xterm，F8）；
- 集成分支（保持合并进主检出当前分支）。

## 6. 验收口径（草案，评估时细化）

1. 开关关闭时：方案执行行为与现状完全一致（回归基线）。
2. 3 条无依赖议题方案，并发 2：总耗时显著低于串行基线；全程无需人工介入合并。
3. 并行过程中主共享目录无任何非预期写入（可用文件监控验证，重点核查 R-1/R-2）。
4. 滚动合并期间用户手工切分支 → 方案暂停 + 通知，无静默错误合并（D7）。
5. 合并冲突 → 自动修复任务成功解冲突继续；连续 2 次失败 → 挂起 + 通知（D8）。
6. 统一构建触发时机 = 全部合并完成；构建前锁预检生效（D9）。
7. 增量构建范围覆盖「方案 diff 工程 ∪ HintPath 引用方」；构造「改 IBll 接口 + 引用方工程」用例验证不漏编（D10/R-5）。
8. 涉 Term/DrugInOut 的议题 → 自动降级串行，期间并行链滚动合并暂停互斥（D12）。
9. 构建修复循环 2 轮后仍失败 → 方案挂起 + 错误清单通知；全程无自动 revert（D11）。

## 7. 开放问题（评估阶段需回答）

1. **junction 写穿透复核**（对应 D3）：运行时目录（Log/Cache/TEMP）经 junction 写主共享目录是否可接受？是否需要更细粒度的目录级隔离（只 junction DLL 文件而非整目录）？
2. **并发上限 2 是否合理**：token 成本、机器负载、以及多任务写各自 `.nezha-build` 的磁盘 IO；是否需要「无人值守时上限提高、值守时降低」的动态策略？
3. **修复任务的权限模式**：冲突/构建修复 agent 任务用什么 permission mode（沿用方案配置还是收紧）？
4. **D10 的 HintPath 引用方枚举完备性**：csproj 静态扫描是否可靠（存在条件包含、props 注入等 MSBuild 动态性的项目怎么办）？是否需要构建产物时间戳校验兜底？
5. **子模块改动守卫的判定时机**（D5）：是 done 时检查 worktree 内子模块 diff，还是运行中就提醒 agent？
6. **滚动合并的通知密度**：每任务合并都通知 vs 只在异常时通知？
7. **构建窗口**：共享目录被运行中程序双写（F13），统一构建是否需要「检测 HIS 程序进程」而非仅文件锁预检？
8. **基线对齐**：`worktree\可执行程序`（8 月 31 日手工拷贝）在 junction 方案下是否还需要、还是删除？
9. **回滚方案**：期 1 上线后发现并行导致合并链频繁异常，如何快速回到纯串行（开关 + 既有任务的处理）？

---

*讨论记录来源：2026-09-29 batch-grill-me 会话（三轮 frontier 问答 + 用户改判：统一构建弃全量改增量、暂缓实施转评估）。同日成本实测（§2.4）与一次真实事故（R-9，由此新增决策 D15 主检出操作禁令）。*
