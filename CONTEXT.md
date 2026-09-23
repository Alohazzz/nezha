# Nezha

AI 编程智能体的桌面任务管理器。本词汇表覆盖**交付管理域**（计划 / 方案 / 议题 / 任务 / worktree）。

## Language

**计划（Delivery Plan）**：
一个可独立交付的单元：一组有序的云效议题＋一条源分支＋可选一个独立 worktree＋至多一个合并请求。由「创建 PR / 分支批」升维而来。
_Avoid_: 批、分支批、批次、PR、创建 PR、BranchBatch

**方案（Plan）**：
针对一个或多个议题的讨论与设计产物（讨论任务＋ plan.md），可被计划详情关联展示。不承载分支、worktree 或 MR。
_Avoid_: 计划、Delivery Plan、spec

**议题（Workitem）**：
云效 Projex 的工作项（如 QHDK-30439）。计划的成员主体；一个议题可产生讨论任务与执行任务。
_Avoid_: 任务（混指议题时）、issue、卡片

**任务（Task）**：
Nezha 内一次智能体执行（待办 / 讨论任务 / 执行任务）。从计划内议题创建的任务强制落在该计划的分支与 worktree 上。
_Avoid_: 工作项、议题、job

**Worktree（代码目录）**：
计划可选的独立 git 工作树；同目录内多任务自由并行。未另建 worktree 的计划带「主检出」徽标，分支直接切在主工作区。
_Avoid_: 工作树、分支批目录

**合并请求（MR）**：
Codeup 平台的 Merge Request，一个计划至多一个。「提交 MR」为保留措辞。
_Avoid_: PR、pull request
