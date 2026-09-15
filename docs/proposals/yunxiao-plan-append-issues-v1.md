# 追加议题（子方案）v1：从云效议题弹窗关联主方案

> 状态：**已实现**（本轮改动即本文档描述的方案）
> 整理日期：2026-09-15
> 关联：[`yunxiao-plan-board-and-lifecycle-v1.md`](./yunxiao-plan-board-and-lifecycle-v1.md)（阶段三「追加议题 = 子方案」的决策来源）· [`yunxiao-plan-deps-gating-v1.md`](./yunxiao-plan-deps-gating-v1.md)（依赖门禁）· [`yunxiao-plan-board-v2.md`](./yunxiao-plan-board-v2.md)（看板 v2）
> 本文解决的问题：v1 已拍板阶段三，但**入口写法自相矛盾且全部未实现**——本文修正入口、补齐实现。

---

## 1. 现状与修正

v1 已定「追加 = 新建子方案」（决策 A2 / B2' / C1 / D-b / R1），但：

| 项 | v1 的写法 | 问题 |
|---|---|---|
| 入场位置 | §5.4 说「方案卡片的『追加议题』」；§6 又说「`PlanPreviewPanel` 加入口」 | **两处矛盾**，且都写在 v2 看板把生命周期动作收进 `PlanDetail` 常驻动作行之前 |
| `parentPlanId` | v1 §5.2 定义字段并进 `types.ts` / `storage.rs` | 字段已就位，但**全仓库无任何写入方或读取方** |
| deps 约束 | v1 §5.3 要求放宽为「本方案 ∪ 祖先链」 | 未实现，跨方案编号仍被 `unknownDependency` 丢弃 |
| 技能契约 | v1 §6 提「技能契约说明 `dependsOn` 可引用祖先方案议题」 | 未实现，且技能文档**明确禁止**写方案外编号 |

**本文的修正**：入口改到**云效议题的「发起讨论」弹窗**——那里已经有多选、筛选、分页与占用置灰（`YunxiaoView` + `useYunxiaoFilters` + `isYunxiaoWorkitemImported`），加一个「关联方案」字段即可；方案看板侧不再单独建一个议题选择器。

---

## 2. 本轮决策

| 编号 | 决策点 | 结论 |
|---|---|---|
| **E1** | 入口位置 | **`PlanLaunchDialog` 加「关联方案」字段**（替代 v1 §5.4 / §6 的两处写法）；方案看板**不**加入口 |
| **E2** | 可用状态 | 关联对象限本项目内 **`finalized` / `executing` / `completed`**，排除 `draft`（R1）、`cancelled`（留存态无恢复路径，追加会造出等一个永不推进的前置的子方案）、`archived`（AR1 已收尾；要追加先反归档） |
| **E3** | 左栏形态 | **缩进树**：子方案挂在主方案下，父行可折叠；**子方案不能被独立筛选**（不出现孤儿行） |
| **E4** | 筛选语义 | **子树语义**：逐方案求值，任一命中即带出**整条祖先链**；折叠在筛选生效时不得藏掉命中分支 |
| **E5** | 依赖图 | 跨方案前置画成**外部节点**（第 0 列、虚线描边 + 标注所属方案），只画被**直接**引用的祖先议题，不展开成跨方案全景 |
| **E6** | 删除守卫 | **拒绝删除有子方案的主方案**（与「仍有任务关联」同构，查任务在前、查子方案在后） |
| **E7** | 技能契约 | SkillHub `yunxiao-plan-discussion` 放宽为「只允许引用**祖先方案**议题」；这是**阻塞项**，见 §5 |
| **E8** | 归属展示 | 子方案详情头部「追加自 ↗ 主方案名」；主方案头部「追加子方案 N 个」；归档区保持平铺但徽标口径统一 |

### 2.1 为什么筛选不能只对根求值

一个必须避开的陷阱：若筛选只对**根**方案求值，则「主方案 A 已 `completed`、追加的子方案 B 在 `executing`」时——

> 用户勾选「执行中」→ A 不命中 → **整棵子树消失，唯一在执行的 B 反而看不见**。

而「父已收尾、子刚立项」恰恰是子方案最常见的形态。因此取**子树语义**：左栏不产生脱离父节点的行（满足 E3），同时筛选命中的子方案一定能被看到。

---

## 3. 实现

### 3.1 数据与契约（切片 1）

| 位置 | 改动 |
|---|---|
| `src/utils/plan.ts` | 新增 `planAncestorChain(planId, plans)`：从直接父级到根，**两级守卫**——`parentPlanId` 成环时靠 `visited` 停在重复节点；父方案已删时**停在断点**（只含仍存在的方案）。新增 `planAncestorSerials` |
| `src/utils/planDeps.ts` | `parsePlanDeps(raw, planSerials, allowedExternalSerials?)`：新增第三个可选参数，**扁平静态白名单**。合法可引用集合 = 本方案 ∪ 白名单；外部编号**不建图键、不进 `executionOrder`、不参与破环**，且引用它**不产生任何告警**（合法引用）。链外编号照旧丢弃 + `unknownDependency` |
| `src/App.tsx` | `readPlanDepsFor(plan, projectPath, allPlans)` 传入祖先链；`refreshPlanDeps` 增 `allPlans` 形参（解析需按 `parentPlanId` 上溯，只看待刷新子集会丢祖先上下文） |

`PlanDepsWarning` 的六种语义**一种都没改**——祖先引用是合法的，本就不该产生告警。

### 3.2 入口（切片 3）

`PlanLaunchDialog` 新增「关联方案」下拉（`SelectField`，候选由 `appendableParentPlans` 纯函数给出）：

- 候选 = 本项目内 `canReceiveAppend(plan)` 为真者，排除正在创建的方案自身，按 `createdAt` 升序；无候选时整块不渲染。
- 选定后 `handleStart` 先落 `parentPlanId`（`onSetParentPlan`）再启动讨论任务——**讨论一跑起来看板就该显示它挂在哪个主方案下**。
- 讨论 prompt 注入 `buildUpstreamPlanContext`：**议题清单内联**（`dependsOn` 要写精确编号，不能靠模型猜）+ **方案文档绝对路径**（可能很长，按需读取，与执行 prompt 同一套做法）。清单里祖先议题**无论是否已有任务都列出**，有任务带状态、无任务标「未生成待办」——门禁对 `missing` / `abnormal` 的处理需要与 agent 对同一份信息有共识。
- 祖先链从**选中的父方案**起算（`[parent, ...planAncestorChain(parent.id, plans)]`），因为 draft 方案的 `parentPlanId` 此刻尚未落库。

### 3.3 看板呈现（切片 4）

| 位置 | 改动 |
|---|---|
| `src/utils/planBoard.ts` | `canReceiveAppend` / `appendableParentPlans`；`buildPlanTree(plans, matches, collapsed, filtersActive)` 纯函数：祖先闭包补全可见集、手动折叠、**筛选生效时命中分支强制展开**、成环与断链兜底 |
| `src/utils/planGraph.ts` | `PlanGraphUpstream` + `deriveUpstreamGraphNodes`；`layoutPlanDependencyGraph(rows, deps, metrics, upstream)` 把外部节点并入分层，使子议题落到第 ≥1 层而非谎称无前置 |
| `src/components/yunxiao/plan/PlanLaunchDialog.tsx` | 加「关联方案」字段（拆出 `PlanLaunchParentField.tsx`）与议题列表（拆出 `PlanLaunchItemList.tsx`），使该文件回到 400 行以内 |
| `src/components/yunxiao/plan/PlanRail.tsx` | 渲染 `plan-rail-node[data-depth]` 缩进 + 折叠开关；`data-ancestor-only` 弱化为带出命中子方案而显示的父方案；归档区加「↳ 主方案名」归属徽标 |
| `PlanDetail.tsx` | 归属链接（追加自 / 追加子方案）；图接 `upstream` 与 `onOpenUpstream` |
| `PlanDepGraph.tsx` | 外部节点 `data-upstream="true"`，序号位显示 `↗`，点击跳所属方案 |
| `ProjectPage.tsx` → `WaitingDepsView.tsx` | Checklist 标题来源扩为「本方案 ∪ 祖先链」，跨方案条目加「来自 {方案}」徽标 |
| `src-tauri/src/yunxiao.rs` | `delete_yunxiao_plan` 增加归属检查 |

实现与自审中发现并修掉的真问题（都由测试逼出，见 §4）：

1. **折叠永不生效**：最初把「带命中后代则强制展开」无条件应用，而无筛选时所有方案都算命中 → 子树永远收不起来。修法：加 `filtersActive` 参数，仅在筛选生效时强制展开。
2. **成环导致整环消失**：`a↔b` 时双方都判定「父会输出我」而互相跳过，两行都不出。修法：上溯祖先时遇已访问节点即判定为环，让环上节点**当根**落地（不丢行、不死循环）。
3. **上游节点状态在渲染层被丢掉**：`PlanDepGraph` 原来只从本方案任务行建 `statusBySerial`，上游议题不在行里 → 一律渲染成「无任务 / `todo`」，而它的边却按真实状态着色（`done` 的前置显示「未生成待办」+ 绿色实线）。这正是外部节点要消除的图-文矛盾。修法：上游数据带来的 `status` 一并并入 `statusBySerial`。
4. **E8 的「归档区徽标口径统一」漏实现**：归档区加了平铺断言却没有归属徽标，测试名还宣称「口径一致」——名不副实。修法：归档行渲染 `↳ 主方案名`（复用既有的 `board.childOf` 文案），并把测试改成真的断言徽标。
5. **「关联方案」下拉一打开就把整页打崩**（用户实测报回）：我给「不关联」项写了 `value: ""`，而 Radix `Select.Item` **禁止空字符串 value**（空串被它保留表示「未选择」），渲染期直接 `throw`，被根 `ErrorBoundary` 接住后整页变成「Something went wrong / Retry」。
   - 触发条件很隐蔽：**只有打开那个下拉才崩**（Radix 仅在展开时挂载 item），所以建方案、选议题都不受影响；且要有「可追加的方案」候选，字段才渲染。
   - 修法：下拉内部用哨兵值 `PARENT_NONE` 表示「不关联」，仅在对外 `onChange` 时换回空串（`""` 仍是 `parentPlanId` 的「未关联」语义，`handleStart` 与 `canReceiveAppend` 都不用改）。
   - 补 `src/test/plan-launch-parent.test.tsx`（6 例）做**回归护栏**：打开下拉不抛错、选中回填 id、切回「不关联」回填空串、候选范围过滤、提示文案切换。其中 4 例在修复前必然抛错——即这条崩溃现在跑测试就能拦住，不必再靠手点。

另有一批代码质量问题在同一次自审中修掉：`deriveUpstreamGraphNodes` 改为复用 `buildTaskBySerial`（原先内联了同一段逻辑）；`buildPlanTree` 的祖先上溯改为复用 `planAncestorChain`（原先三处各自手写带 `guard` 的上溯循环）；`refreshPlanDeps` 的三个 `Plan[]` 位置参数改为具名对象（原调用点是 `(loadedPlans, loadedProjects, loadedPlans)` 这种同类型易错写法）；`ProjectPage` 的两个 memo 合并为一个方案上下文（原先各自 `plans.find` + 上溯）；`WaitingDepsView` 改用 `planTitle`；`PlanLaunchDialog` 拆出 `PlanLaunchParentField` / `PlanLaunchItemList` 回到 400 行以内；删掉 `PlanTreeRow` 上只被测试读的 `parentId` / `childIds` 与 `PlanRail` 里恒真的 `depth >= 0`。

### 3.4 执行 prompt 的上游路径

`buildPlanExecutionPrompt` 增可选 `upstreamPlanMdAbsolutePath`（仅 `parentPlanId` 存在时由 `handleGeneratePlanTodos` 填入）：附「上游方案全文」节并强调**不要执行上游方案的改动**。这补掉一个真实缺口——子方案的 `## 统筹` 是**看过主方案清单**的 agent 写的，它会自然引用上游编号，而执行者无从查证。**根方案的 prompt 逐字节不变**。

---

## 4. 测试

- `src/test/plan-deps.test.ts`（+7 例）：祖先链编号可引用且零告警、外部编号只作引用方（不建键 / 不进执行顺序）、祖先编号**不允许**作为 `issues[]` 条目、链外编号照旧告警、自依赖判定不受白名单影响、不传白名单行为与从前一致、跨方案前置被如实报告为未满足。
- `src/test/plan-utils.test.ts`（+13 例）：`planAncestorChain` 多级/断链/成环/self-parent；`planAncestorSerials`；`buildUpstreamPlanContext`（空祖先不产出、清单与路径、状态文案、多级追加）；执行 prompt 的上游节（缺省不加、空串同义、强调只执行本议题）。
- `src/test/plan-board.test.ts`（+13 例）：`canReceiveAppend` 五状态与归档；`appendableParentPlans` 同项目/排除自身/排序/空候选；`buildPlanTree` 深度优先与 `depth`、子树语义带出祖先链、命中父不命中子、折叠严格生效、筛选时强制展开、断链当根、成环不丢行、全不命中返回空。
- `src/test/plan-graph.test.ts`（+13 例）：跨方案节点落第 0 层 / 子议题落第 1 层、外部节点带所属方案、边状态口径（running→unmet / null→abnormal / done→satisfied）、只画被直接引用的上游议题、不传 upstream 行为不变、多前置排序可复现；`deriveUpstreamGraphNodes` 的祖先交集、未引用不入图、无 deps 返回空、根方案不产出、断链不产出。
- `src/test/plan-board-render.test.tsx`（+10 例）：缩进 `data-depth`、筛选只命中子方案时父被带出（`data-ancestor-only`）、折叠收起子树、归属链接双向跳转、跨方案边画成外部节点且可点跳、**上游节点状态渲染**（`done` → 「已完成」且与边一致 / 无任务 → 标红异常）、归档区平铺但带归属徽标。
- `src/test/plan-launch-parent.test.tsx`（新增 6 例）：「关联方案」下拉的渲染与交互，兼作 Radix 空值崩溃的回归护栏（见 §3.3 第 5 条）。
- 四个 `yunxiao-*.test.tsx` 补 `onSetParentPlan` 桩（新增必填 prop）。

**结果**：`tsc` 0 错误 · `eslint --max-warnings 0` 通过 · `vitest` **54 文件 / 427 用例全绿**（阶段二基线 362）· `vite build` 成功。

> **关于全量跑偶发失败**：`yunxiao-select-scroll.test.tsx` 与 `file-viewer-language.test.ts` 在全量并行下会**轮换**出现超时（单独跑恒过，失败信息是 `Test timed out in 5000ms` 而非断言不符），属并行负载下的既有脆弱，非本轮引入。前者已按同目录兄弟测试的既有写法显式放宽到 `15_000`；后者未动。

---

## 5. 阻塞项：SkillHub 技能契约（切片 2，必须先落地）

SkillHub `yunxiao-plan-discussion` 的 `SKILL.md` 原文**明确禁止**写跨方案依赖：

> 依赖关系只写**方案内议题之间**的。引用了方案外的编号（其他方案、其他项目）一律不要写进来——文件里出现方案外编号会被丢弃。

且自检项第 8 条重复「每个 `dependsOn` 只指向方案内其他编号」。

**这是禁止性条款，不是缺失条款**：不改它，讨论 agent 即便拿到主方案清单也会按契约拒绝写跨方案边，门禁永不生效，而且失败是**静默的**（`deps.json` 语法合法，只是没有那条边）。因此该更新**排在入口之前**，避免出现「功能已可见但 agent 拒写边」的中间态。

改法（保留原防护意图，只放开一个受控例外）：

1. `dependsOn` 范围改为「本方案议题之间 + **上游方案**的议题编号」；其余方案 / 项目编号照旧禁止。
2. 新增「追加方案：引用上游方案」一节：判据（前置产出是本议题输入）、**无依赖就不要写**、只允许引用上游及更上层祖先、引用前先读上游方案文档、依赖上游议题的后果（`waiting_deps` / 标红 / 「忽略依赖仍然开始」）、`executionOrder` 仍只列本方案议题。
3. 自检项第 8 条与抬头「第二份机器契约」段同步。
4. `src/test/plan-deps.test.ts` 的技能文档契约锁（`SKILL_DOC_EXAMPLE`）不受影响——该示例是方案内依赖，两种场景都合法。

> SkillHub 是独立 git 仓库，本轮只改本地工作区，**提交推送待维护者确认**。

---

## 6. 明确不做（本期范围外）

- **方案看板侧的追加入口**：本期只在云效议题弹窗开这一扇门；看板侧另建议题选择器会与 `YunxiaoView` 的筛选项立刻开始漂移。
- **子方案之间的互相依赖**（v1 的 B3）：本期只支持「子 → 祖先」单向，方向单一才不会引入「新议题成为在跑议题前置」的反向不可满足。
- **上游议题的递归展开**：图里只画被直接引用的祖先议题，不展开祖先自己的前置。
- **归档区按父子缩进**：归档区保持平铺（收尾清单语义），但归属徽标口径与主列统一。
- **图内缩放 / 平移、依赖图编辑**：沿用 v2 §8。

---

## 7. 已知边界

- **端到端未覆盖**：跨方案门禁的运行链路（子任务 `waiting_deps` → 父任务 `done` → 放行）没有新增集成用例——它测的是 `evaluateTaskGate`，而 `plan-queue.test.ts` 已单独覆盖该纯函数。本轮覆盖的是契约放宽、祖先链解析、分层与子树筛选这些**新**逻辑。
- **子方案归档后**：会出现在「已归档」区，那里不缩进（见 §6）；若需缩进，先反归档。
- **主方案被删**：已被守卫拒绝（E6）。守卫查任务在前、查子方案在后，两条错误文案分别显示，避免用户来回折腾；删除确认文案已补「仍有任务或追加子方案关联时会被拒绝」。
- **UI 截图**：本轮的界面变化（缩进树、图外部节点、归属链接）需真实创建一个子方案才可见，须冷启动桌面应用并真连云效账号，截图留待维护者手验后补。
