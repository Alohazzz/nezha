# 方案并行编排 · 一期演练结果（2026-10-14）

> 配套：[`plan-parallel-orchestration-v2.md`](./plan-parallel-orchestration-v2.md)（设计）与
> [`plan-parallel-orchestration-v2-rehearsal.md`](./plan-parallel-orchestration-v2-rehearsal.md)（手册）。
> 本报告是**实测数据**，不是设计意图；两者冲突处以本报告为准。

## 0. 一句话结论

**机制成立，瓶颈转移。** worktree 隔离、一议题一 commit、白名单 100% 干净、主检出零写入、
落地 dry-run 无冲突——设计的四条安全属性全部实测通过。但 50 分钟里有**约 40 分钟花在
「让子 agent 真的干活」上**：worker 收不到任务、有 worker 误以为自己是编排者、有 worker
调 `wait_agent` 把自己挂死 28 分钟、审查 agent 与修复 agent 各空转十几分钟，最后编排者
**自己下场写完了 TEST-103 的代码**。git 层没事，协调层是新的战场。

## 1. 运行参数

| 项 | 值 |
|---|---|
| 样本 | 测试项目 `fixture-plan-parallel`（TEST-101 / TEST-102 / TEST-103，`dependsOn` 全空） |
| 驱动方式 | `codex exec --dangerously-bypass-approvals-and-sandbox --json -C <项目>`（非交互；对应 Nezha 的 `full_access` 任务） |
| 基线 | commit `6387b7e`，`npm test` = 18 用例 / 15 通过 / 3 失败 |
| 编排者提示词 | 演练手册 §4 原文（2669 字符） |
| 墙钟 | **3002 秒（50.0 分钟）**，退出码 0 |
| 产出 | 3 议题 commit + 3 merge + 1 审查修复 commit；3 份回写包；1 份编排台账 |

## 2. M1 墙钟分解

| 阶段 | 耗时 | 说明 |
|---|---|---|
| worktree 建立（4 个） | **0.99 s** | 集成分支 + 3 议题 worktree（对比 HIS 实测 17 s/任务，含子模块初始化） |
| 并行 worker 段 | **≈ 25 min** | TEST-101 ≈7 min、TEST-102 ≈10 min、TEST-103 ≈25 min |
| └ 其中空耗 | **≈ 18 min** | worker_103 挂死 + 两次改派失败 + 编排者接管 |
| 提交段（3 次 commit） | 1.8 s | |
| 合并段（3 次 merge + 解冲突） | 0.6 s | 含一次真冲突的人工解决 |
| 尾部第 1 轮 `npm test` | 0.89 s | **18/18 全绿** |
| code-review（双轴） | **≈ 17 min** | 12:43–13:00；Spec 轴首派空转 14 min 后改派 |
| 修复 + 尾部第 2 轮 | ≈ 5 min | 唯一实质问题（过期 JSDoc）由编排者自己改 |
| 回写包拷贝 + 落地 dry-run | ≈ 1 min | |

**要点：尾部（审查 + 修复）≈ 22 分钟，与并行段同量级。** 本样本的「构建」是 0.89 秒的测试套件；
HIS 的尾部是增量构建（分钟级到十几分钟），这一项会被放大。

## 3. M2 隔离纪律：源码层零越界，协调层一锅粥

**源码层（通过）**

- 主检出 `git diff --stat` 为空、`HEAD` 始终是 `6387b7e`、`git status` 与演练前逐字节一致；
- 三个 worker 的全部改动落在各自 worktree 内，未出现互相覆盖；
- 冲突发生在集成分支的独立 worktree 里，主检出未被波及。

**协调层（4 类失效，全部记录在编排台账里）**

1. **初始 brief 未进入 worker 上下文**：101/102 靠自查恢复；
2. **worker_test_102 自认是编排者**：做了 3 次 `spawn_agent` + 2 次 `followup_task`（全失败），
   并在**主检出**跑了一次基线 `npm test`（只读，无写入）；
3. **worker_test_101 越权转发 brief** 给 102/103 并各 `interrupt` 一次；
4. **worker_test_103 调 `wait_agent(300s)` 把自己挂死 28 分钟**，零落盘。

> 即：F19（子 agent 与 root 共享 cwd 且共享全套工具）在演练里同时以「无写入越界」和
> 「角色混乱」两种形式兑现——**共享工具集是设计缺陷，必须靠契约禁用**。

## 4. M3 归属正确率：100%，但两条硬约束是编排者自己发现的

| 议题 | commit | 文件集 | 与白名单 |
|---|---|---|---|
| TEST-101 | `efd502e` | `src/http/integrationClient.js`、`src/patientRegistry.js` | ✅ 2/2 |
| TEST-102 | `1c35956` | `src/validation/checksum.js`（新增）、`idCard.js`、`insuranceCard.js` | ✅ 3/3 |
| TEST-103 | `e1773c4` | `src/logger.js`、`src/patientRegistry.js` | ✅ 2/2 |

三条 commit 的 message 均含 `#TEST-10x closed`。

**发现 1｜`git add -A` 会把回写包卷进议题 commit。** 编排者用 `git check-ignore -v` 证明了
`.gitignore` 的 `.nezha/plans/*/discussion.md` **不覆盖** `writeback/<编号>/discussion.md`，
于是把契约里的 `add -A` 主动改成**显式白名单路径 add**——三份提交因此只含 2/3/2 个文件。
→ 设计必须把「回写包绝不进入议题 commit」写成硬约束，**不能依赖某个仓库的 gitignore 恰好覆盖**。

**发现 2｜「分片改动不重叠 ⇒ 能干净合并」被证伪。**

```
Auto-merging src/patientRegistry.js
CONFLICT (content): Merge conflict in src/patientRegistry.js
实际 tree 79c58c45…  ≠  纯三方自动 tree 95030032…
```

TEST-101（+12/−6）与 TEST-103（+15/−8）**各自都重写了同一段函数体**：方案文档统筹节里
「两个议题的改动区域不重叠」是讨论阶段的乐观判断，实际代码层面并不成立。冲突由编排者按
统筹节的仲裁规则人工解决（错误语义取 101、日志派生取 103），并自曝「未记入 run-log」。
→ **冲突路径必须是显式设计**（v1 的 D8「冲突自动生成修复任务」从备选升为必需），
而审慎的默认是：**同一文件被两个议题碰 = 高风险信号**，应在派活前就标出来。

## 5. M4 尾部：零构建在本样本成立，但审查才是真成本

- **第 1 轮 `npm test` 就 18/18 全绿**——包括那次人工解冲突之后。三个 worker 在
  「不构建、不跑测试」的约束下产出的代码，第一次整体验证即通过（TEST-101 的三个红灯全部转绿）。
- code-review 双轴：Standards 报 6 条判断题、0 硬违规；Spec 报 0 缺失 / 0 越界 / 0 硬违规。
  唯一实质问题是一处**与实现矛盾的过期 JSDoc**。
- 修复由编排者自己执行（修复 worker 空转 8 分钟），提交 `5328f31` 直接落在集成分支。
- 第 2 轮 `npm test` 仍 18/18。

**结论：D6「零构建」在本样本上可接受**（错误没有后置堆积，首轮即绿）。
但要注意两个前提：① 本样本是「小改动 + 秒级测试」；② 尾部的**审查环节**耗时 17 分钟，
在 HIS 上会与增量构建叠加，成为新的固定成本。

## 6. M5 代价

| 会话 | input | cached | output | total |
|---|---|---|---|---|
| ROOT（编排者） | 8 447 918 | 8 378 112 | 72 212 | 8 520 130 |
| worker_test_101 | 5 454 397 | 5 363 840 | 77 180 | 5 531 577 |
| worker_test_102 | 2 733 520 | 2 677 888 | 53 600 | 2 787 120 |
| worker_test_103（零产出） | 2 142 252 | 2 102 528 | 23 366 | 2 165 618 |
| review_standards | 1 497 478 | 1 454 208 | 27 864 | 1 525 342 |
| review_spec（空转后改派） | 777 379 | 736 128 | 8 680 | 786 059 |
| fix_review_findings（空转） | 456 048 | 421 632 | 6 055 | 462 103 |
| **合计** | **21 508 992** | **21 134 336** | **268 957** | **21 777 949** |

- 9 个会话（1 root + 6 子 agent），转录总量 ≈ 6 MB；
- **约 3.4M tokens（≈16%）落在两个零产出的会话上**；worker_101 的 5.5M 里有相当部分
  花在「转发 brief 并中断别人」这种越权动作上；
- 缓存命中率 98%（21.1M/21.5M），真实增量成本主要在 output（269k）。

## 7. 偏离契约清单 → 每条的设计含义

| # | 偏离 | 设计含义 |
|---|---|---|
| 1 | `add -A` → 显式白名单 add | D4 加硬约束：回写包不得进入议题 commit |
| 2 | brief 未进 worker 上下文；worker_102 自认编排者并越权 spawn/followup | **worker 的任务正文必须自包含在它的 prompt 里**，不得依赖二次「brief」传递；worker 契约硬禁协作工具 |
| 3 | worker_101 越权转发 brief + interrupt 同伴 | 同上：worker 禁止 `spawn_agent` / `followup_task` / `send_message` / `interrupt_agent` |
| 4 | worker_103 调 `wait_agent` 挂死 28 min | worker 禁 `wait_agent`；编排者需要**worker 心跳/超时**（例如 10 分钟无落盘即介入） |
| 5 | TEST-103 的代码与回写包由编排者代做 | 需要明确「编排者不得代写业务代码」或显式降级规则，否则并行收益被编排者的串行时间吃掉 |
| 6 | Spec 审查首派空转 14 min；修复 worker 空转 8 min | 审查与修复同样需要**超时 + 改派**策略，不能无限等 |
| 7 | 方案的一条 grep 判据字面不成立 | 方案契约需要「验收判据必须可机器验证」纪律（现在只约束了改动路径） |

## 8. 对 v2 设计的修订建议

- **保持**：D2（每议题 worktree）、D3（编排者统一提交 + 白名单）、D5（一次性落地 + 主检出只读）、
  D9（逐方案开关）——四条均实测成立。
- **D4 增补**：回写包落盘位置必须与议题 commit 隔离（显式路径 add，或落在 worktree 之外）。
- **D6 保持**（零构建），但补：尾部审查要有超时与改派，不能把「等 agent」当成串行时间。
- **D7 增补**：冲突路径从「备选」升为「必需」，且冲突解决必须进 run-log 并接受独立审查。
- **D10 增补**：并发槽位语义 = **同时运行**（不是已创建）；worker prompt 必须自包含。
- **新增 D12｜worker 契约硬约束**：禁用协作工具（spawn/followup/send/interrupt/wait）、
  禁止在自己 worktree 之外执行任何命令（含只读）、完工必须输出结构化自检结论。
- **O2 得到支持**：worktree 建在项目内可行且开销可忽略（0.99 s）。

## 9. 尚未回答

1. **规模效应**：本样本尾部 ≈ 22 min（审查占 17）。议题数 5→10 时，审查与协调成本是否线性膨胀？
   Codex 的 4 槽位上限意味着并行度封顶，N 大时靠前沿滚动——滚动本身会不会引入新的等待税？
2. **冲突自动修复**是否纳入一期（v1 D8）？本次冲突是**人工**解决的，且解决质量未被独立验证
   （只有测试通过这一条外部证据）。
3. **HIS 尾部**：增量构建接入后，零构建的收益是否仍成立？
4. **编排者代写代码**的边界：本次它写了 TEST-103 的全部改动。这算「正确降级」还是「设计漏洞」？
