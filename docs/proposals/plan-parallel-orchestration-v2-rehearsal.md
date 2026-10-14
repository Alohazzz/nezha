# 方案并行编排 · 一期手工演练手册

> 配套 [`plan-parallel-orchestration-v2.md`](./plan-parallel-orchestration-v2.md)（§7）。
> **零代码演练**：不写 Nezha 代码、不碰 HIS，全部在测试项目
> `H:\Project\nezha-plan-test-project` 上进行。演练目的是在投入实现之前，拿到
> M1 加速比 / M2 隔离纪律 / M3 归属正确率 / M4 尾部成本 四个真实数据。

## 0. 演练样本（已就绪）

| 项 | 值 |
|---|---|
| 方案 | `.nezha/plans/fixture-plan-parallel/`（测试项目内，已提交 `6387b7e`） |
| 议题 | `TEST-101`（真 bug）/ `TEST-102`（抽取重复逻辑）/ `TEST-103`（traceId 派生） |
| 依赖 | `deps.json` 三条 `dependsOn: []` —— **互不依赖，可全部并行开工** |
| 特意埋的冲突面 | TEST-101 与 TEST-103 **都改 `src/patientRegistry.js`，但落在不同区域**（错误处理段 vs 日志调用点）——这正是真实批次里最值得验的假设 |
| 验收判据 | 尾部 `npm test` 从 **18 用例 / 15 通过 / 3 失败** → **18/18 全绿**；那 3 个红灯就是 TEST-101 的判据 |
| 白名单来源 | 每议题节末尾 `### 改动范围与产出物` 的「预计改动范围」路径清单（契约强制写成路径） |
| 重置 | `node scripts/reset-test-state.mjs --apply` → 回初始状态（会 `git clean` 掉未跟踪的方案目录，故夹具必须已提交） |

`fixture-plan-chain` 是硬依赖链（101→102→103），**不用于本次演练**（它验证的是串行门禁）。

## 1. 前置

1. 测试项目已重置到初始状态：`node scripts/reset-test-state.mjs --apply`，`node scripts/check-baseline.mjs` 自检通过；
2. 演练任务用 **agent = codex / 权限 `full_access`**（`workspace-write` 沙箱会挡掉 worktree 写入，且子 agent 无人在场审批）；
3. 确认主检出 `git status --porcelain` 只有已知的未跟踪项，**无被跟踪文件的改动**；
4. 记录基线墙钟：串行跑完这三条议题的时间（可先按现状串行跑一遍，或复用历史数据）。

## 2. 步骤

> 全部命令在项目根 `H:\Project\nezha-plan-test-project` 下执行。`.` 指项目根。

**S0 记录基线**

```powershell
git rev-parse HEAD                              # 记录基线 commit
git status --porcelain                          # 记录初始脏点
npm test                                        # 记录用例数：期望 18/15/3
```

**S1 建集成分支与各个 worktree**（都在项目内，`.nezha/worktrees/` 已被 gitignore）

```powershell
git branch rehearsal/integration <基线commit>
git worktree add .nezha/worktrees/_integration rehearsal/integration
foreach ($n in 'TEST-101','TEST-102','TEST-103') {
  git worktree add -b "rehearsal/$n" ".nezha/worktrees/$n" rehearsal/integration
}
git worktree list
```

**S2 派 worker**（把 §4 的提示词交给编排者；编排者一次 `spawn_agent` 出 3 个 worker）

**S3 编排者按议题提交**（worker 不碰 git）

```powershell
# 每议题：先白名单校对，再提交
git -C .nezha/worktrees/TEST-101 status --porcelain
git -C .nezha/worktrees/TEST-101 add -A
git -C .nezha/worktrees/TEST-101 commit -m "fix(http): 业务失败归一化为 IntegrationError #TEST-101 closed"
# TEST-102 / TEST-103 同理（message 必须含 #编号 与 closed）
```

**S4 逐个合并进集成分支**（在集成分支 worktree 里做，记录是否冲突）

```powershell
git -C .nezha/worktrees/_integration merge --no-ff rehearsal/TEST-101 -m "merge #TEST-101"
git -C .nezha/worktrees/_integration merge --no-ff rehearsal/TEST-102 -m "merge #TEST-102"
git -C .nezha/worktrees/_integration merge --no-ff rehearsal/TEST-103 -m "merge #TEST-103"
```

**S5 尾部**（只在集成分支 worktree 内）

```powershell
cd .nezha/worktrees/_integration
npm test                                        # 期望 18/18；失败则按「文件 → 议题 commit」定位责任议题
```

**S6 落地 dry-run（本轮禁止真合并）**

主检出当前分支是 `master`，演练**不**真的合并过去。用无工作区副作用的 `merge-tree` 检查落地是否会冲突：

```powershell
git -C . merge-tree --write-tree master rehearsal/integration   # 无冲突时输出 tree sha；有冲突时列出冲突路径
git -C . worktree list                                          # 确认主检出仍在 master、工作区未被写
```

**S7 产出回写包**

编排者把三份包写到项目根的 `.nezha/plans/fixture-plan-parallel/writeback/<编号>/`：

- `discussion.md`：三小节 `## 修改方案汇总` / `## 影响范围与测试（测试向）`（**修改分支** / **修改文件** / **测试步骤** 三行加粗）/ `## 价值评分`；
- `knowledge.json`（本测试项目 `[knowledge] graph_id = ""`，可留空对象）。

> ⚠ `.nezha/` 被 gitignore（HIS 同样如此），**回写包不会随 merge 带过来**——worker 在自己
> worktree 里写的那份必须由编排者**显式拷贝**回主检出的 `.nezha/plans/...`。这是 D4 的实现要点。

**S8 收尾**

```powershell
node scripts/verify-fixtures.mjs                # 确认方案文档未被演练改坏
git worktree remove .nezha/worktrees/TEST-101 --force   # 三个议题 worktree + 集成分支 worktree
git branch -D rehearsal/TEST-101 rehearsal/TEST-102 rehearsal/TEST-103 rehearsal/integration
node scripts/reset-test-state.mjs --apply       # 回初始状态
```

## 3. 数据记录表

| 指标 | 口径 | 记录值 |
|---|---|---|
| **M1** 墙钟 | S1 / S2（并行段）/ S3+S4（提交合并段）/ S5（尾部）/ 总计；对照串行基线 | |
| **M2** 隔离纪律 | ① worker 写进主检出或别的 worktree 的越界次数；② `git -C <wt> status` 出现非本议题预期路径的次数；③ 是否出现互相覆盖（同一区域被两个 worker 改） | |
| **M3** 归属 | ① 一议题一 commit 达成；② commit 路径 ⊆ 白名单；③ TEST-101 与 TEST-103 在 `src/patientRegistry.js` 上的改动是否干净合并；④ 回写包 `修改文件` 与 `git show --stat <commit>` 的一致率 | |
| **M4** 尾部 | ① `npm test` 首轮是否 18/18；② 失败时的「文件 → 议题」反查是否可行；③ code-review 发现问题数 / 采纳数；④ 修复轮次 | |
| **M5** 代价 | 每议题 worktree 建立耗时；子 agent 数（≤3）；token 用量（可从子线程 rollout 统计） | |

## 4. 编排者契约提示词（给编排任务，可直接粘贴）

```text
你是本方案的「编排者」。目标：把 `.nezha/plans/fixture-plan-parallel/` 的三个议题
（TEST-101 / TEST-102 / TEST-103）并行落地到集成分支，产出每议题的回写包，并在集成分支的
单点上做一次验证。

## 环境事实
- 项目根（= 主检出，禁止写入）：H:\Project\nezha-plan-test-project
- 方案文档：.nezha/plans/fixture-plan-parallel/plan.md（三个议题节；每节末尾
  「### 改动范围与产出物」里的「预计改动范围」路径清单 = 该议题的提交白名单）
- 依赖：.nezha/plans/fixture-plan-parallel/deps.json —— 三条 dependsOn 全为 []，可全部并行开工
- 基线：开工前用 `git rev-parse HEAD` 记录；主检出当前分支 master
- 验证判据：`npm test` 基线 18 用例 / 15 通过 / 3 失败，尾部必须 18/18 全绿
- 并发上限：你 + 最多 3 个 worker

## 硬约束（违反即停止并报告）
1. 主检出只读：不得在主检出里改文件、commit、merge、checkout。所有写操作发生在 worktree 内。
2. worker 禁止一切 git 写操作（add / commit / stash / checkout / reset / 分支操作），只改文件；
   所有提交一律由你执行。
3. 禁止 `git reset --hard` / `git clean` / `git stash` / `git checkout -- <path>`。
4. worker 阶段不构建、不跑测试：只改代码 + 静态自检（方案要求的符号是否真实存在、
   改了接口是否列出被引用方、有没有只改一半）。
5. worker 只准在自己 worktree 的绝对路径下改动。任何写进主检出或别的 worktree 的动作都算越界，
   立即停止并记录。
6. 每个 worker 只做自己议题节描述的改动，不做顺手重构、不改格式。

## 步骤
1. 记录基线：HEAD、git status --porcelain、npm test 结果。
2. 建集成分支与 worktree（都在项目内 `.nezha/worktrees/` 下）：
   - `git branch rehearsal/integration <基线commit>`
   - `git worktree add .nezha/worktrees/_integration rehearsal/integration`
   - 每议题：`git worktree add -b rehearsal/<编号> .nezha/worktrees/<编号> rehearsal/integration`
3. **一次 spawn 3 个 worker**（不要串行等），每个 worker 的 prompt 包含：
   - 本议题节的**原文**（从 plan.md 逐字复制，不要改写、不要省略）；
   - 它的工作目录绝对路径（如 H:\Project\nezha-plan-test-project\.nezha\worktrees\TEST-101）；
   - 「只在这个目录下改动 / 禁止一切 git 写操作 / 不构建不测试 / 路径白名单（列出该议题
     预计改动范围）/ 不做顺手改动」；
   - 交付要求：在**自己的 worktree 内**写
     `.nezha/plans/fixture-plan-parallel/writeback/<编号>/discussion.md`，含三小节
     `## 修改方案汇总`、`## 影响范围与测试（测试向）`（三行加粗字段：**修改分支** /
     **修改文件** / **测试步骤**）、`## 价值评分`；并在汇报里给出一句话改动摘要与
     自检结论（改了哪些文件与符号、引用是否闭合）。
4. 全部完工后逐议题收口：`git -C <worktree> status --porcelain` → 与白名单比对（越界不静默，
   记一条）→ `git -C <worktree> add -A && git -C <worktree> commit -m "<type>(<scope>): <subject> #<编号> closed"`。
5. 逐个 merge 进集成分支（在 `.nezha/worktrees/_integration` 里执行 `git merge --no-ff <分支>`），
   每次记录是否冲突、冲突文件与解决方式。
6. 尾部（只在集成分支 worktree 内）：跑 `npm test`。若未全绿，按「失败文件 → 议题 commit」
   定位责任议题，派一个修复 worker 修，**上限 2 轮**；两轮仍失败就停下来报告。
7. 测试全绿后跑 code-review（可并行出多个审查 worker），派一个 worker 统一修审查问题，
   修完重跑 `npm test` 确认。
8. 产出回写包：把三份 worker 产出的包**显式拷贝**回主检出的
   `.nezha/plans/fixture-plan-parallel/writeback/<编号>/`（`.nezha/` 被 gitignore，
   不会随 merge 带过来）。
9. **本轮不真的落地**：主检出停在 master 不动。只用
   `git merge-tree --write-tree master rehearsal/integration` 做一次落地冲突 dry-run。
10. 报告一张表：每议题 commit sha / 改动文件数 / 越界次数 / 合并是否冲突 / 尾部轮次 /
    各阶段墙钟耗时；以及你遇到的所有偏离本契约的地方。

## 记录要求
全程记录墙钟时间（worktree 建立 / 并行段 / 提交合并段 / 尾部），以及每一次越界、冲突、
尾部失败（编号 + 现象 + 处理）。
```

## 5. 判停条件（出现即停下，不要"想办法绕过去"）

1. 任何 worker 写进主检出或别人的 worktree —— 停下，记录越界细节（这是 M2 的核心数据，比"修好它"有价值）；
2. worker 报告"需要改白名单之外的文件" —— 停下记一条，由人决定是否放行；
3. 尾部测试两轮仍不全绿；
4. 合并出现冲突 —— **不要**自动解决，先记录（本轮要看的是「分片改动能不能干净合并」这个假设成不成立）；
5. 主检出出现任何被跟踪文件的改动。

## 6. 演练后要回答的问题

1. **M1 加速比**是否值得为它改 Nezha？（若 3 条议题的并行净收益接近持平，D1/D6 都要重估）
2. **M2 越界**是否为 0？若非 0，是"纪律问题"还是"机制缺口"（例如必须给 worker 一个更强的工作目录锚点）？
3. TEST-101 与 TEST-103 对 `src/patientRegistry.js` 的分片改动**能否干净合并**？若冲突，冲突在哪一行、
   是语义冲突还是纯粹的上下文冲突？
4. 尾部的 `npm test` 一次性通过率如何？「错误文件 → 议题 commit」的反查在实际输出里可用吗？
5. 回写包的三小节结构在并行场景下能否稳定产出（含 **修改文件** 与 `git show --stat` 的一致率）？
6. 零构建（D6）是否真的可接受？若首轮失败率高，是否必须提前到「单工程轻检」？
