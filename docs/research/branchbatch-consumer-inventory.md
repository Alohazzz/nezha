# 调研：BranchBatch / 「创建 PR」消费点与耦合面清单（2026-09）

> 目的：为「DeliveryPlan 数据模型与迁移」决策与提案 spec 的 **Scope** 章节提供一手依据（wayfinder 票据 `issues/01-branchbatch-consumer-inventory.md`）。
> 问题：BranchBatch / 「创建 PR」概念在代码库里**全部消费点与耦合面**有哪些？每处读/写哪些字段？
> 结论先行：**概念集中在 `src/components/branch-batch/`（5 文件）＋ `src-tauri/src/batch.rs`（868 行 / 10 命令）＋ `storage.rs::Batch`；但耦合面外溢到 `ProjectPage`（batch state 宿主，**不在 App.tsx**）、`TaskList` 按批分组、`RunningView` 门禁、`codeup.rs` MR 回写、`useProjectPanels` 面板键、`docs/operation-manual` §6。共约 60 处显式消费点。**
> 调研方法：primary source（源码本身）逐条查证，每条标注 `文件:行号` + 读/写 + 字段。标注「休眠 / 无写者 / 无读者」的均为 grep 全库确认，非推测。
> 状态：事实清单可直接引用；迁移影响面提示为工程判断，供决策而非结论。

---

## 0. 概念与术语对齐

- **BranchBatch（分支批）**＝一个可独立验收的 PR 容器：一个分支（可选一个 worktree）＋ N 个议题任务。见 `src/types.ts:128-168`（TS）与 `src-tauri/src/storage.rs:238-306`（Rust，**两处必须同步**）。
- **即将升维**为「计划（DeliveryPlan）」：云效议题为成员（**不再是 taskIds**）、一计划一分支、就地迁移 `batches.json`。代码命名 `DeliveryPlan`（`Plan` 名留给方案）。
- **易混淆**：i18n / 设置里的 `batchGrill` / `batch_grill_enabled`（`appSettings.batchGrill`、`plan.launch.batchGrillHint`）是 **`batch-grill-me` 技能开关**，与 BranchBatch **完全无关**，本清单不计。同理 `codeup_create_mrs_batch`（「待发起」批量 MR）刻意**不绑批**（`codeup.rs:1032-1034`），也不属本概念。

---

## 1. 前端消费点

### 1.1 `src/components/branch-batch/`（5 文件，概念主目录）

#### `BranchBatchView.tsx`（275 行，PR 面板主视图）

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:5,9` | — | `BranchBatch/BranchBatchStatus/Task`、`batchScopeKey` | 类型与作用域工具导入 |
| `:11-20` | 读 | `status` | `STATUS_LABEL`：8 个 `BranchBatchStatus` 全覆盖（含 `draft/conflict/approved/rejected`——**后端从不写这 4 个**，见 §3） |
| `:25-30` | 读 | `status` | `statusTone`：status→徽标色调 |
| `:53,62-66` | 读 | 全字段 | `invoke list_branch_batches` 拉列表（写 `batches` state） |
| `:79-86` | 读 | `worktreeMissing`、`useWorktree/worktreePath/id`（经 `batchScopeKey`） | `scopedBatches`：仅当前作用域的批 |
| `:89-92` | 读 | `worktreeMissing` | `missingBatches`：失效批保留清理入口 |
| `:94-107` | 读 | `id` | `handleOpen` → `invoke open_branch_batch_worktree` |
| `:109-136` | 读 | `id/useWorktree/name` | `handleDelete` → `invoke delete_branch_batch`（`useWorktree===false` 走「删除 PR」文案，否则「删除 WorkTree」） |
| `:138` | 读 | `status` | `canSubmit = status==="active"`（提交 MR 门禁） |
| `:140-205` | 读 | `name/status/kind/useWorktree/worktreeMissing/runRootMissing/status+createdAt/additions/deletions/branch/baseBranch/targetBranch/taskIds` | `renderBatchCard`：卡片渲染全字段消费（`taskIds` 只取 `.length` 计数 `:170`） |
| `:250-258` | 写 | 新 `batch` 全字段 | `CreateBranchBatchDialog onCreated`：`setBatches([...prev,batch])` + `batchScopeKey` |
| `:263-270` | 读 | `batch` 对象 | 传给 `SubmitMrDialog` |

#### `CreateBranchBatchDialog.tsx`（543 行，创建 PR 对话框）— **核心写入入口**

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:22-28` | 读 | `kind` | `KINDS`：feature/fix/patch/project/hotfix |
| `:31-33` | — | `version`（**瞬态**） | `normalizeVersionSegment`：云效版本名→分支版本段（去尾 `.0`） |
| `:80,94,112` | 读 | — | `load_app_settings` / `yunxiao_list_versions`（版本下拉）/ `list_branch_pr_repos`（多子仓库选仓库） |
| `:130` | 读 | — | `get_branch_batch_worktree_base`：默认代码目录 |
| `:144-151` | 读 | `baseBranch`（默认值） | `git_list_branches` → 当前分支回填 `baseBranch` |
| `:164-169` | 读 | `kind/version/targetBranch/name` | `preview_branch_batch_branch` → `sourceBranch`（源分支名预览） |
| `:179-182,207-214` | 读 | `taskIds`（来源） | `projectTasks` 勾选集 → `selected: Set<string>`（**成员选择器，迁移时移除**） |
| `:221-225` | 读 | `branch`（冲突） | `check_branch_batch_branch` → `remoteConflict/localConflict` |
| `:270-285` | **写** | `id/name/kind/baseBranch/targetBranch/taskIds/sourceBranch/useExistingRemote/worktreeDir/version/useWorktree` | `invoke create_branch_batch`，`id: crypto.randomUUID()`；**不传 `issueSerialNumbers`**（默认空）。`worktreeDir: useWorktree?…:null`，`useWorktree` 缺省 **false** |

> 注：本对话框整体用 `s.bb*` 样式对象（`styles/branch-batch.ts`），触碰 AGENTS.md「禁 inline style」债，重写时一并迁出。

#### `SubmitMrDialog.tsx`（120 行，提交 MR 对话框）

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:28,44,79,95,106-107` | 读 | `targetBranch` | 空则禁提交（与后端同口径） |
| `:34,51` | 读 | `worktreeRepo` | 作 `repoPath`（多子仓库下按批所属仓库查评审人 / 提 MR） |
| `:31-35` | 读 | `worktreeRepo/targetBranch` | `codeup_branch_managers` → 默认审核人 |
| `:52` | 读 | `id` | 作 `batchId` 传 `codeup_create_mr` |
| `:78,95` | 读 | `branch/name` | 展示 + MR 标题/来源 |

#### `WorktreeScopeSelect.tsx`（64 行，作用域下拉 UI）

- 纯展示：`WorktreeScopeOption{key,label,description}`，props `options/value/onChange`。**不触任何 batch 字段**（消费点在 `worktreeScope.ts` 与 `ProjectPage`）。

#### `worktreeScope.ts`（55 行，作用域推导）

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:11-13` | 读 | `worktreePath/id` | `batchWorktreePath`：`worktreePath ?? \`${projectPath}/.nezha/worktrees/${id}\``（**旧版硬编码路径回退**，与后端 `batch.rs:495-502` 同源） |
| `:16-18` | 读 | `useWorktree` | `batchScopeKey`：`useWorktree===false ? "" : batchWorktreePath` |
| `:21-54` | 读 | `useWorktree/status/worktreeMissing/worktreePath/id` | `buildWorktreeScopeOptions`：合并 task worktree + batch worktree 去重；跳过 `merged/closed/worktreeMissing` |

### 1.2 `src/components/task-panel/TaskList.tsx` — 按批分组

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:58` | 读 | 全列表 | props `batches: BranchBatch[]` |
| `:121-124` | 读 | `taskIds[]` | `taskToBatch`：`batch.taskIds→batch` 归组映射（注释明言**任务自身不写 batchId**） |
| `:143-155` | 读 | `id/branch` | 分组：worktree 任务优先，否则 `batch`→key `batch:${id}`、label `WorkTree · ${branch}` |
| `:163-183` | 读 | — | `appendGroup`：组头 + `onCreateTaskInGroup(group.key)` |

### 1.3 `src/components/RightToolbar.tsx` — PR 入口

| 位置 | 读/写 | 字段 | 说明 |
|---|---|---|---|
| `:36` | — | 面板键 `"branch-batch"` | `{ key:"branch-batch", icon:GitPullRequest, title:"PR" }`（标题「PR」**硬编码**，非 i18n）。**迁移决策已定移除项目内 PR 面板**，此条 + §1.4 渲染块为去留重点 |

### 1.4 `src/components/ProjectPage.tsx` — **batch state 宿主（不在 App.tsx）**

| 位置 | 读/写 | 依赖字段 | 说明 |
|---|---|---|---|
| `:7,49-51` | — | 类型/组件 | `BranchBatch`、`BranchBatchView`、`WorktreeScopeSelect`、`buildWorktreeScopeOptions` |
| `:332-333` | 写 | state | `batches: BranchBatch[]`、`worktreeScope: string` |
| `:363-366` | 读 | 全列表 | `loadBatches` → `invoke list_branch_batches` |
| `:720-722` | 写 | `worktreeScope` | `handleScopeChange`：set + `loadBatches` |
| `:728` | 读 | `status/useWorktree/worktreePath` | `worktreeOptions = buildWorktreeScopeOptions(...)` |
| `:733-736` | 读 | `worktreeScope` | 失效作用域回落主检出 |
| `:1363-1365,1453-1455` | 读 | 作用域 | `WorktreeScopeSelect`（主右侧面板 + 构建面板两处） |
| `:1410-1420` | 读 | 全字段 | `rightPanel==="branch-batch"` → `<BranchBatchView …/>`（`shellOpen` 与 Shell 面板路径耦合 `:1416`） |
| `:1373,1384-1385,1401-1402,1462-1464` | 读 | `worktreeScope` | **作用域→右面板联动**：`worktreeScope` 作 `projectPath/repoPath/worktreePath` 喂给 `FileExplorer / GitChanges / GitHistory / BuildPanel` |

### 1.5 `src/hooks/useProjectPanels.ts`

- `:8`：`RightPanel` 联合类型含 `"branch-batch"`（面板开关状态键）。

### 1.6 `src/components/RunningView.tsx` — Task.batchId 门禁

| 位置 | 读/写 | 字段 | 说明 |
|---|---|---|---|
| `:513,544` | 读 | `Task.batchId` | `!task.batchId` 时才显示「合并 worktree / 丢弃 worktree」按钮（批任务应由批级合并/删除接管）。**注意：`Task.batchId` 全库无写者**（§4），此门禁当前对批任务实际不生效——迁移需补齐或改判据 |

### 1.7 i18n（`src/i18n.tsx`）与样式

- **PR/批相关文案大多硬编码中文**，不在 i18n：`BranchBatchView.tsx:11-20`（STATUS_LABEL）、`:114-116/:200`（删除 PR / 删除 WorkTree）、`:219/:191`（新建 PR / 提交 MR）、`CreateBranchBatchDialog.tsx` 全部字段标签。→ 迁移改「计划」措辞时是**逐处替换**，非改 key。
- 真正的 i18n key：`plan.preview.batchLinked`（EN `:1047` "batch linked" / ZH `:2135` "已挂批"）—— `Plan.batchId` 徽标用。
- **无关 key（勿混）**：`appSettings.batchGrill*`、`plan.launch.batchGrillHint`（`batch-grill-me` 技能）。
- 样式：`src/styles/branch-batch.ts`（导出 `bbHeader/bbBackBtn/bbBtnPrimary/bbBtnGhost/bbList/bbDialog/bbField/bbInput…`，`styles/index.ts:4` 聚合）＋ `BranchBatchView` 用的 `styles/right-panel.ts::rpRootStyle` / `pr-card*` / `pr-badge` / `pr-metric*`。

---

## 2. 后端命令

### 2.1 `src-tauri/src/batch.rs`（868 行）— 10 个 Tauri 命令（`lib.rs:512-521` 注册）

| 命令 | 行号 | 读/写 | 依赖字段 / 说明 |
|---|---|---|---|
| `preview_branch_batch_branch` | `:103-116` | 读 | `kind/version/target_branch/name` → 分支名（纯函数 `batch_branch_name :73-100`）。**sync fn** |
| `create_branch_batch` | `:123-330` | **写** | 核心写入。参数含 `task_ids/issue_serial_numbers/version/use_worktree`。落 `Batch{status:"active":308, worktree_path:316, worktree_repo=owner_repo:319, use_worktree:320, additions/deletions=None:311-312, issue_serial_numbers:313, mr*=None}`。`VALID_KINDS:14`；`use_worktree.unwrap_or(false):159`。`save_project_batches:325` |
| `list_branch_batches` | `:347-387` | 读 | 读列表 + 计算 `BatchView.runRootMissing/worktreeMissing:372-376`（**瞬态不落盘**）。`is_open = status≠merged&≠closed:356` |
| `get_branch_batch` | `:391-395` | 读 | 按 `id` 取单条 |
| `close_branch_batch` | `:406-421` | **写** | `status = merged? "merged":"closed":416`、`closed_at:417`（**状态机合并/关闭点**） |
| `merge_branch_batch` | `:435-493` | 读+写 | 读 `kind`（`merge_allows_kind`，hotfix 禁合并 `:17-19`）、`target_branch:451`、`worktree_repo:455`、`branch/use_worktree:467/worktree_path:468`；调 `close_branch_batch(…,true)→"merged":466`；清 worktree/分支 |
| `check_branch_batch_branch` | `:523-539` | 读 | `branch` 冲突预检（remote/local exists）→ `BranchConflictCheck` |
| `open_branch_batch_worktree` | `:543-565` | 读 | `use_worktree:553/worktree_path:554/worktree_repo:557` → 打开目录 |
| `delete_branch_batch` | `:571-759` | 读+删 | 读 `use_worktree/worktree_path/worktree_repo/branch/task_ids:605`（未完成任务门禁）、`mr_id:623`→`batch_mr_is_merged`、`mr_source_sha:632-641`（防删后新增提交）、`target_branch/base_branch:707`（切回落点）。尾部 `remove_batch_record` 或 `close_branch_batch(…,false)→"closed":753-758` |
| `get_branch_batch_worktree_base` | `:763-775` | 读 | 纯路径：worktree 默认基目录 |

辅助：`legacy_batch_worktree_path:495-502`（`${projectPath}/.nezha/worktrees/${id}`，与前端 `worktreeScope.ts:12` 同源）；`BatchView:333-343`（flatten `Batch` + 两个瞬态缺失标志）。

### 2.2 `src-tauri/src/storage.rs` — `Batch` 结构与 `batches.json`

| 位置 | 读/写 | 字段 | 说明 |
|---|---|---|---|
| `:238-306` | — | 全字段 | `pub struct Batch`：TS `BranchBatch` 的 Rust 镜像（**schema 双端同步红线**） |
| `:290-291,309-311` | — | `use_worktree` | `default_use_worktree() → **true**`（旧记录缺省「有 worktree」）——与创建时缺省 **false** 相反，见 §5 风险 |
| `:255-256` | — | `task_ids` | 注释：「必须始终序列化…缺失会让 TS 侧迭代 undefined 崩溃」 |
| `:269-274` | — | `issue_serial_numbers` | `skip_serializing_if = Vec::is_empty` |
| `:276-305` | — | `mr_id/mr_status/mr_source_sha/worktree_path/worktree_repo` | `Option`，空则跳过序列化 |
| `:81-82` | — | `Task.batch_id` | 字段定义（rename `batchId`），**无写者** |
| `:206-210` | — | `Plan.batch_id` | 字段定义（rename `batchId`），**无写者** |
| `:329-331` | — | 路径 | `batches_path` → `~/.nezha/projects/<id>/batches.json` |
| `:414 / :425` | 读 / 写 | 全字段 | `load_project_batches` / `save_project_batches`（`atomic_write`） |
| `:508-509` | 注册 | — | `load_project_batches` / `save_project_batches` 在 `lib.rs` 暴露给前端 |

### 2.3 `src-tauri/src/codeup.rs` — MR 关联字段

| 位置 | 读/写 | 字段 | 说明 |
|---|---|---|---|
| `:583-588` | 读 | `id` | `load_batch`：按 id 取批 |
| `:591+` | 读 | `mr_id` | `batch_mr_is_merged`：查 MR 是否已合并（删除门禁） |
| `:928-1026` | 读+**写** | 见下 | `codeup_create_mr`：读 `status=="active":937`、`target_branch` 非空 `:940`、`use_worktree:951`、`worktree_path/worktree_repo:952-954`、`branch`；push 源分支后创建 MR，**回写**：`mr_id=local_id:1019`、`mr_status="opened":1020`、`status="review":1021`、`mr_source_sha:1022`（**状态机 active→review**） |
| `:1017-1018` | — | `mr_id` 约定 | 存 **localId**（云效 MR 详情/动作路径段），删除门禁 `batch_mr_is_merged` 正拿它查状态 |
| `:1032-1034` | — | — | `codeup_create_mrs_batch`（「待发起」批量）**刻意不绑批**，不属本概念 |

---

## 3. 数据字段读写矩阵

> 图例：**W**=写点，**R**=读点，`💤`=休眠（无读者 / 无写者 / 从不填充），`瞬`=瞬态不落盘。行号见 §1/§2。

| 字段 | 写点 | 读点 | 备注 |
|---|---|---|---|
| `id` | W `batch.rs:300`（←前端 `crypto.randomUUID` CreateDialog `:274`） | R 列表/单查/删/合并/打开的键；`worktreeScope.ts:12` 旧路径嵌入；`TaskList:151` `batch:${id}`；`codeup.rs:947` push 路径 | UUID；旧 worktree 路径含它 |
| `projectId` | W `batch.rs:301` | R 存储路径 | |
| `name` | W `batch.rs:302` | R `BranchBatchView:146`、`SubmitMrDialog:95`、`codeup.rs:1006-1007`（MR 标题/描述） | |
| `kind` | W `batch.rs:303` | R `merge_allows_kind` hotfix 禁合并 `batch.rs:445,17-19`；`codeup.rs:1007`；`BranchBatchView:150` 徽标；分支名前缀 `batch.rs:74-80` | hotfix=挑拣容器不可合并 |
| `branch` | W `batch.rs:304`（`source_branch` 或 `batch_branch_name`） | R `TaskList:152`、`BranchBatchView:167`、`SubmitMrDialog:78`、`codeup.rs:986` push、删/合并分支操作 | 源分支名 |
| `baseBranch` | W `batch.rs:305` | R 分支切出基 `batch.rs:251,283`；删除切回落点 `batch.rs:707-708`；`BranchBatchView:168` | |
| `targetBranch` | W `batch.rs:306` | R 合并门禁非空 `batch.rs:451`；MR 门禁非空 `codeup.rs:940`+`SubmitMrDialog:28/44/106`；分支名目标段 `batch.rs:93-96`；删未合并计数 `batch.rs:670`；`BranchBatchView:169`、`SubmitMrDialog:79/95` | 空=不能提 MR/合并 |
| `taskIds` | W `batch.rs:307`（←CreateDialog `selected` Set） | R `TaskList:123-124` 归组成员；删未完成任务门禁 `batch.rs:605`；`BranchBatchView:170` 计数 | **成员关系**；迁移→云效议题成员 |
| `status` | W `batch.rs:308`→`active`；`batch.rs:416`→`merged/closed`；`codeup.rs:1021`→`review`；`batch.rs:753-758`→`closed`/移除 | R `batch.rs:356` is_open；`BranchBatchView:138` canSubmit；`codeup.rs:937` MR 门禁；`BranchBatchView:11-30` 标签/色调；`worktreeScope.ts:46` 跳过 merged/closed；`BranchBatchView:154` 超期 | 状态机见下 |
| `createdAt` | W `batch.rs:309` | R `BranchBatchView:154-158` 超期（14 天） | |
| `closedAt` | W `batch.rs:417` | R 无活跃读者 | 展示留存 |
| `additions` / `deletions` | W `batch.rs:311-312`→`None`（**无其它写者**） | R `BranchBatchView:159-164` | `💤` **从不填充**：diff 统计走 `worktree_diff_stats`→**Task**.additions/deletions，不回填 Batch |
| `issueSerialNumbers` | W `batch.rs:313`（create 参数，默认空） | R **无** | `💤` 注释称「commit 门禁与回写」，但提交门禁 `git.rs:validate_commits_contain_tag:1299` 的 tag 来自别处（`GitChanges` 的 `issueTag`←`Task.yunxiaoSerialNumber`，ProjectPage `:1384-1392`），不读 batch |
| `mrId` | W `codeup.rs:1019`（=**localId**） | R 删门禁 `batch.rs:623-625`→`batch_mr_is_merged:591` | 存 localId 约定见 `codeup.rs:1017-1018` |
| `mrStatus` | W `codeup.rs:1020`（=`"opened"`） | R **无** | `💤` 只写不读（展示字段，无消费者） |
| `mrSourceSha` | W `codeup.rs:1022` | R 删门禁防新增提交 `batch.rs:632-641` | 有载荷：删批前比对源分支 HEAD |
| `worktreePath` | W `batch.rs:316`（仅 `use_worktree` 时） | R `worktreeScope.ts:12` 回退；缺失探测 `batch.rs:360-368`；打开 `batch.rs:554`；合并/删除 `batch.rs:468/582`；`codeup.rs:952` push 目录 | 绝对路径；缺省回退 `${projectPath}/.nezha/worktrees/${id}` |
| `worktreeRepo` | W `batch.rs:319`（=owner_repo，与 use_worktree 无关） | R `resolve_repo_path`（合并/打开/删/提 MR）；`SubmitMrDialog:34/51` | 多子仓库 sub-repo 落点 |
| `useWorktree` | W `batch.rs:320`（创建缺省 **false** `:159`） | R `worktreeScope.ts:17` 归属作用域；`batch.rs:359` 路径推导；`:553` 打开；`:467` 合并清理；`:616/703/711` 删除分支；`codeup.rs:951` push 目录；`BranchBatchView:142/151` 主检出徽标 | **旧记录缺省 true**（`storage.rs:309`），与创建缺省 false 相反 |
| `runRootMissing` | 瞬 `batch.rs:372-374` | R `BranchBatchView:153` | `瞬` 不落盘 |
| `worktreeMissing` | 瞬 `batch.rs:375-376` | R `BranchBatchView:82/90/152`、`worktreeScope.ts:46` | `瞬` 不落盘 |
| `version`（版本段） | W create 参数 `batch.rs:140`→仅入分支名 `:88-91` | R `preview_branch_batch_branch:105` | `瞬` **不持久化在 Batch**（结构体无此字段）；v+数字判据 `batch.rs:59-66` |
| `Plan.batchId` | W **无** | R `PlanTaskView:141`、`PlanPreviewPanel:201-202`（「已挂批」徽标） | `💤` 无写者（`types.ts:439` 注释「生成待办时创建的分支批 id」，但 `GeneratePlanTodosDialog` 不自动建批） |
| `Task.batchId` | W **无** | R `RunningView:513/544` 门禁 | `💤` 无写者（`TaskList:121` 注释证实；成员关系走 `batch.taskIds`）——**潜在 bug**：门禁当前不生效 |
| `Task.branchKind` | W 随批 | R — | 缺省跟随批或 feature |
| `Task.worktree*`（`worktreePath/branch/baseBranch/repo/discarded/additions/deletions`） | W 任务生命周期（独立） | R `worktreeScope.ts:34`、`TaskList:143-149`、`RunningView` | 与 batch 并行的另一套 worktree 元数据 |

### 状态机（`BranchBatchStatus`：`draft/active/review/conflict/approved/merged/rejected/closed`，`types.ts:185-193`）

实际流转点（后端只写 4 个值）：

```
create_branch_batch  → active            (batch.rs:308)
active → review       codeup_create_mr   (codeup.rs:1021)
active → merged       merge_branch_batch → close_branch_batch(true)  (batch.rs:466,416)
active/… → closed     delete_branch_batch → close_branch_batch(false) 或移除记录  (batch.rs:753-758,416)
```

- **`draft` / `conflict` / `approved` / `rejected` 无任何写者**——仅存在于 `STATUS_LABEL`（`BranchBatchView:11-20`）与类型联合，纯展示占位。
- 读侧门禁：`canSubmit=active`（`BranchBatchView:138`）、`codeup_create_mr` 要 `active`（`codeup.rs:937`）、`is_open=≠merged&≠closed`（`batch.rs:356`）、超期徽标 `≠merged&≠closed`（`BranchBatchView:154`）。

---

## 4. 外部引用

| 引用面 | 位置 | 读/写 | 说明 |
|---|---|---|---|
| `Plan.batchId` | `types.ts:438-439` | R（`PlanTaskView:141`、`PlanPreviewPanel:201`） | 方案→批关联；**无写者**（💤） |
| `Task.batchId` | `types.ts:375-376` | R（`RunningView:513/544`） | 任务→批关联；**无写者**（💤） |
| `worktreeScope` 作用域→右面板联动 | `ProjectPage:1373-1464` | R | `worktreeScope` 作 `projectPath/repoPath/worktreePath` 喂 `FileExplorer/GitChanges/GitHistory/BranchBatchView/BuildPanel`——「一计划一分支/worktree」的落点即此处 |
| `useProjectPanels` 面板键 | `useProjectPanels.ts:8` | — | `"branch-batch"` ∈ `RightPanel` |
| `docs/operation-manual.md` §6 | `:428-465`（+`:4` 功能线索引、`:38` 令牌复用、`:607-609` 排障） | — | 「创建 PR」章节：6.1 新建 PR（字段表含「选择议题」「另建 worktree」）、6.2 提交合并请求、6.3 发起合并 |
| `docs/operation-manual.html` §6 | `:695-729`（+`:6`/`:176` 标题、`:885-887` 排障） | — | 同上 HTML 版（首页帮助 iframe 源） |
| `docs/yunxiao-launch-modes.html` | `:414,478` 等 | — | 仅「不建 worktree」措辞引用；`batch-grill` 无关 |

---

## 5. 测试

| 文件 | 行数 | 覆盖 |
|---|---|---|
| `src/test/branch-batch-actions.test.tsx` | 170 | `BranchBatchView`：只暴露 打开/提交/删除、隐藏 worktree 路径、`runRootMissing` 提示不阻断、`worktreeMissing` 保留清理；`SubmitMrDialog`：审核人预填（目标分支规则）、加审核人、`codeup_create_mr` 收 `batchId:"b1"`、后端报错展示。夹具 `baseBatch`：`taskIds[]/status:"active"/worktreePath` |
| `src/test/worktree-scope.test.ts` | 75 | `buildWorktreeScopeOptions`：保留活跃 task+batch worktree、隐藏 `missing/merged/closed/discarded`、旧版项目内路径回退 `${projectPath}/.nezha/worktrees/${id}` |
| `src/test/worktree-scope-select.test.tsx` | — | 作用域下拉 UI |
| `src/test/branch-batch-version.test.ts` | — | `normalizeVersionSegment`（去尾 `.0`） |
| `storage.rs` 内测试 `:490-582` | — | `batch_serde_round_trip`（`taskIds/issueSerialNumbers/additions/useWorktree`）、`batch_without_use_worktree_field_defaults_to_true`（旧记录缺省 true）、`task_legacy_json_without_batch_fields_defaults_none`（`Task.batchId/branchKind` 缺省 None） |
| `batch.rs` 内测试 `:793-868` | — | `batch_branch_name` 形态（类型/版本/目标/描述）、版本段 v+数字规则、`merge_allows_kind`（hotfix 禁合并） |

---

## 6. 对迁移的影响面提示（DeliveryPlan）

> 供「DeliveryPlan 数据模型与迁移」决策与 spec Scope 参考，非结论。

1. **成员：`taskIds` → 云效议题（风险最高）**。`taskIds` 全部消费点仅 3 读 + 1 写：`TaskList:123-124`（归组）、`batch.rs:605`（删批未完成任务门禁）、`BranchBatchView:170`（计数）、`create` 写。迁移换成员类型（workitemId/serialNumber）后：
   - `CreateBranchBatchDialog:468-479`「选择议题」勾选器**整体移除**（钉决策：成员一律经议题列表「添加到计划」补）。
   - 删批门禁 `batch.rs:604-609` 现以 `batch.taskIds ∩ tasks` 判未完成任务——改议题成员后须能 `workitemId→task` 解析，否则门禁失效。
   - `issueSerialNumbers`（现 💤 只写）正是议题编号的天然落点，但**读路径需新接**（提交 tag 门禁 `git.rs:1299` 现不读 batch）。

2. **`useWorktree` 双默认值反转（迁移地雷）**。创建缺省 **false**（`batch.rs:159`），旧记录反序列化缺省 **true**（`storage.rs:309 default_use_worktree`）。`batchScopeKey`/`worktreeScope`/旧路径回退（`worktreeScope.ts:12`、`batch.rs:495`）全依赖它。「一计划一分支＋可选 worktree」沿用此开关时，**就地迁移 `batches.json` 必须显式写 `useWorktree`**，不能让缺省语义在新旧记录间漂移。

3. **状态机 4 个死状态 + 3 个休眠字段**。`draft/conflict/approved/rejected` 无写者；`additions/deletions`（从不填充）、`mrStatus`（只写不读）、`issueSerialNumbers`（只写不读）均为 💤。`mrSourceSha` 有载荷（删批防新增提交）。迁移可**简化状态机为 `active/review/merged/closed`**，并逐个决定休眠字段「补线 or 丢弃」——尤其 `Plan.batchId`/`Task.batchId` 无写者但 `RunningView:513/544` 门禁依赖 `Task.batchId`，是**现存潜在 bug**（批任务的合并/丢弃按钮未被抑制），迁移应顺带修正判据。

4. **`worktreeScope` 作用域联动必须保留**。`ProjectPage:1373-1464` 用 `worktreeScope` 驱动 5 个右侧面板的文件/Git 上下文。决策「移除项目内 PR 面板、创建入口移至云效议题视图」只去 `RightToolbar:36` 入口 + `ProjectPage:1410-1420` 渲染块；`buildWorktreeScopeOptions` + `WorktreeScopeSelect` + `worktreeScope` 联动**须存活**（否则文件树/Git 面板丢 worktree 上下文）。

5. **MR 耦合靠 `localId`**。`batch.mr_id` 存 **localId**（`codeup.rs:1017-1018`），删批「已合并门禁」`batch_mr_is_merged` 拿它查。改 `batchId→planId` 命名时须保留此约定，否则删除门禁静默失效。

6. **分支名生成双端同源、与 `pending_mr` 解析耦合**。`batch_branch_name`（`batch.rs:73-100`）+ `preview_branch_batch_branch` 的版本段 v+数字判据（`:59-66`）必须与 `pending_mr.rs::is_version_like`/`infer_target_branch` 对齐，否则「待发起」目标推断失败。升维改实体名**不改分支命名规范**则此面不动。

7. **i18n / 文档措辞清理面**。PR/批文案**大多硬编码中文**（`BranchBatchView`/`CreateBranchBatchDialog`），非 i18n key——改「计划」是逐处替换；真 key 仅 `plan.preview.batchLinked`。文档 `docs/operation-manual.{md,html}` §6「创建 PR」整章（含字段表、排障表）需重写，注意 `batch-grill*` key **无关勿动**。

8. **schema 双端同步红线**。`types.ts:128-168` ↔ `storage.rs:238-306` 逐字段镜像；`task_ids`/`use_worktree` 注释明言「必须始终序列化」（`storage.rs:254-255,288-289`）。就地迁移 `batches.json` 须写迁移逻辑（AGENTS.md「字段重命名写迁移」），并补 `storage.rs`/`batch.rs` 测试夹具（现有 round-trip + 旧记录缺省测试是迁移回归的护栏）。
