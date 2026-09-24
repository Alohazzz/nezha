# 提案：计划创建时留空「合并回目标分支」后，「提交 MR」永久锁死且无补记入口

> 标题（拟）：`fix(plan): 计划创建时留空合并目标后「提交 MR」永久锁死，补一个事后补记入口`
> 流程：AGENTS.md「提交前流程」issue-first —— 本文件为**提案正文**，先开会话 issue 等 maintainer 批复（label `accepted` 或评论确认）后再动代码。
> **状态：已按方向 A + B 实现**（maintainer 直接授权修复）。实现与验证记录见文末「实现结果」。
> 涉及前端交互改动，按规范需附「改前 vs 改后」对照、亮/暗主题与多状态截图（已产出，见 `docs/pr-screenshots/plan-target-backfill-*.png`）。
> 本文件只描述问题、方向与范围，**不含实现**。

---

## Problem Statement

### 触发场景

在「计划」视图里选一个**已完成开发**的计划，点右上角「**提交 MR**」——**没有任何反应**：按钮不弹层、不报错、悬停也没有提示，点下去像点了块死木头。计划状态是「进行中」，WorkTree 也正常（没有「WorkTree 缺失」徽标）。

计划详情的分支行长这样：

```
fix/v2.20260901/QHDK-30486-处方打印医保类别勾选报错  ←  master  →  （未指定合并目标）
```

「（未指定合并目标）」就是病根：这个计划创建时把「合并回目标分支」**留空了**。

### 根因（已实证）

「提交 MR」按钮被**静默禁用**：

- 前端 `src/components/delivery-plan/PlanPanel.tsx:395-407`：
  ```tsx
  disabled={selected.status !== "active" || !selected.targetBranch || selected.worktreeMissing}
  ```
  计划是 `active`、无 worktree 缺失，唯一命中的就是 `!selected.targetBranch`。而这个 `<button>` **没有 `title`**，所以悬停也没有任何说明。
- 后端两道门**都在正确拦截**（不是后端故障）：
  - `src-tauri/src/codeup.rs:940` —— 提交 MR 时若目标分支为空直接返回错误；
  - `src-tauri/src/delivery_plan.rs:450` —— 合并时同样拦截。
- 弹层自身也有一层静默返回：`src/components/branch-batch/SubmitMrDialog.tsx:44`
  ```ts
  if (!batch.targetBranch.trim() || busy) return;   // 静默、无提示
  ```

我用一支临时测试复现了截图里的场景（`status=active` + 有 `worktreePath` + `targetBranch: ""`），点击实测：

```
[DEBUG-repro] disabled = true
[DEBUG-repro] title    = null      ← 无任何说明
弹层未打开                          ← 断言失败（"无反应"复现）
```

再做差分，**只改 `targetBranch` 这一个变量**，结果完全反转：

| 变量（其余全同） | 按钮 disabled | title | 点击结果 |
|---|---|---|---|
| `targetBranch: ""` | **true** | **null** | 无反应，弹层不打开 |
| `targetBranch: "master"` | false | — | 正常打开「提交合并请求」弹层 |

所以「目标分支为空」是唯一的致病变量，repro 已最小化到「一个计划 + 一次点击」。

### 为什么不只是「提示没写清楚」，而是个死结

`targetBranch` **全代码库只有创建时写一次**，之后没有任何入口能改：

- `src-tauri/src/delivery_plan.rs:159` 读取入参并在 `:307` 落盘，**这是唯一的赋值点**，位于 `create_delivery_plan` 内部；其余 13 处（`delivery_plan.rs` / `codeup.rs`）全是**读**。
- `src-tauri/src/lib.rs:512-524` 注册了 13 个 `delivery_plan::*` 命令，**没有** `update_delivery_plan`（或任何补记目标分支的命令）。
- 前端唯一的输入框在 `src/components/branch-batch/CreatePlanDialog.tsx:440-448`，即创建对话框；`grep targetBranch` 全库确认没有第二处可写。

因此这个按钮会**永久锁死**：用户干完活儿想收尾，却发现收不了尾。

### 痛点

1. **完成后无法收尾**：既提交不了 MR（6.3），也合并不了（6.4），计划卡在「进行中」出不去。
2. **后端的错误文案是一句悬空指引**：`delivery_plan.rs:450` 写着「…无法合并；如需合并请先提交 MR 或**补记目标分支**」——它让你「补记目标分支」，但**根本没有补记的入口**。
3. **文档把「留空」写成正常用法，却没写怎么补救**：`docs/operation-manual.html:783` 明确「允许留空 = 暂不指定合并目标……计划照常创建，但不能提交 MR / 合并回」。用户理解成「以后再指定」，实际是「以后再也指定不了」。
4. **删掉重建不是真出路**：目标段是**分支名的一部分**（`fix/v2.20260901/<目标>/<描述>`，见 `delivery_plan.rs:75-102`）。重建计划会生成**另一个分支名**，已完成的提交还留在旧分支上——等于把已干的活儿留在原地，还得人工搬。
5. **静默禁用是反反馈的**：既禁用、又不给理由、点击还无响应，用户无法区分「我操作错了」和「这里有前置条件没满足」。

### 为什么「补入口」优于备选

- **备选 A：创建时把目标分支改成必填。** 会破坏 `4508679`（"make target optional"）刻意引入的能力——确实存在「先开分支、合并目标待定」的真实场景；且**修不了存量数据**：截图里这个计划已经存在了。
- **备选 B：只给按钮加 `title` 提示。** 成本最低，但**只解释、不解决**——用户看懂了还是提交不了。可作为配套，不作为主方案。
- **备选 C：让用户在 `SubmitMrDialog` 里选目标分支，直接创建 MR。** 方向对，但顺序上有个坑：`codeup_create_mr` 会从磁盘重新 `load_plan` 并读 `batch.target_branch`（`codeup.rs:936`），所以**必须先落盘**再建 MR，否则弹层里选的目标分支根本不生效。
- **推荐：给已存在的计划补一个目标分支编辑入口 + 一个 `update_…` 命令回写**，让存量与新建计划都能收尾。且目标分支是「选一条真实存在的分支」，用下拉选择而非自由输入，天然防拼写错误。

---

## Solution

> 主方案（方向 A，推荐）：把计划详情分支行的「目标分支」段做成**可点击编辑**；填写后立即可提交 MR / 合并回。并给禁用的「提交 MR」补 `title`，指向上面的编辑入口（解释 + 出路，两者都要）。

### A. 目标分支可事后补记（推荐）

计划详情分支行 `{源分支} ← {基础分支} → {目标分支}` 的**目标段**变成可编辑控件：

- 未指定时展示为可点击的「（未指定合并目标）」占位（视觉上明确「可点」，不再是纯灰文字）；
- 点击展开选择器，候选 = 该仓库的本地 ∪ 远端分支（复用既有 `git_list_branches` 与 `SelectField`），选中即回写；
- 回写成功后分支行就地刷新，`提交 MR` 按钮随 `targetBranch` 变为可用；
- 仅当计划处于**进行中**时可编辑（已提交 MR / 已合并的计划，目标分支已固化，不可再改）。

### B. 禁用按钮解释清楚（配套）

`提交 MR` 被禁用时补 `title`，例如「未指定合并回目标分支，无法提交 MR；请先在上方分支行补记目标分支」——避免「点了没反应」的反反馈。`SubmitMrDialog.tsx:44` 的静默 `return` 同样补一条可见提示（兜底路径）。

### 改后 mockup（低保真）

```
改动点①：分支行的目标段可点编辑（默认态）
┌────────────────────────────────────────────────────────────────┐
│ 处方打印问题修复  [进行中]  fix  主检出                    [+] [提交 MR]│
│ fix/v2.20260901/QHDK-30486-…  ←  master  →  （未指定合并目标）▾ │
└────────────────────────────────────────────────────────────────┘
                                                    ↑ 可点击占位

改动点②：点开后是分支选择器（本地 ∪ 远端）
┌────────────────────────────────────────────────────────────────┐
│ fix/v2.20260901/QHDK-30486-…  ←  master  →  [ 选择目标分支 ▾ ]  │
│                                            ┌─────────────────┐ │
│                                            │ develop         │ │
│                                            │ master   ✓当前  │ │
│                                            │ release/v2.6    │ │
│                                            └─────────────────┘ │
└────────────────────────────────────────────────────────────────┘

改动点③：补记后，按钮解禁、分支行就地刷新
┌────────────────────────────────────────────────────────────────┐
│ 处方打印问题修复  [进行中]  fix  主检出              [+] [提交 MR]│   ← 可用
│ fix/v2.20260901/QHDK-30486-…  ←  master  →  master              │
└────────────────────────────────────────────────────────────────┘

改动点④：仍被禁用时，悬停给出原因（而非无反应）
                                        ┌──────────────────────────────┐
   [提交 MR]  ← 灰                    │ 未指定合并回目标分支，无法提交 │
                                        │ MR；请先在上方分支行补记目标分支│
                                        └──────────────────────────────┘
```

### C.（可选，范围外但相关）把「更新计划」做成通用能力

本次是 `targetBranch` 一个字段，但病根是**计划的生命周期在创建处是一道单向门**——任何字段写错 / 留空都只能删掉重建。若要一次性避免同类 bug，可把一个**部分更新** `update_delivery_plan` 做成正式能力（列白名单可改字段），本次只接 `target_branch`。**建议先按 A+B 收敛范围**，C 视 maintainer 意见决定是否纳入。

---

## User Stories

### 补记目标分支

1. 作为干完活儿、想收尾的开发者，我想在计划详情里直接补记合并回目标分支，这样我不用删掉重建计划。
2. 作为开发者，我想从**真实存在的分支列表**里选目标分支，而不是手输，这样我不会因为拼错分支名造出一个无效 MR。
3. 作为开发者，我想补记目标分支后「提交 MR」立刻变为可用，这样我不用刷新或重开视图。
4. 作为开发者，我想补记的目标分支就地显示在分支行（替换「（未指定合并目标）」），这样我能一眼确认改对了。
5. 作为开发者，我想在计划**已经提交 MR / 已合并**后不能再改目标分支，这样不会出现「MR 目标与计划记录不一致」。
6. 作为开发者，我想把目标分支改成与源分支不同的分支时被拦下并提示，这样不会造出一个源=目标的畸形 MR。

### 不再「无反应」

7. 作为用户，我想在「提交 MR」被禁用时悬停能看到**为什么**禁用，这样我能区分「我操作错了」和「缺前置条件」。
8. 作为用户，我想在被禁用时的提示里**直接告诉我下一步去点哪里**（分支行补记目标分支），这样我不用猜。
9. 作为用户，我想在「WorkTree 缺失」等其它禁用原因下也看到对应文案，而不是一律沉默——不同禁用原因给不同提示。

### 收尾闭环（存量与新建）

10. 作为已在旧版本创出「空目标」计划的用户，我想**存量计划**也能补记目标分支，这样历史数据不会被这个 bug 卡死。
11. 作为新建计划的用户，我想**创建时仍然允许留空**（保留 `4508679` 的语义），但事后能补，这样「先开分支、目标待定」的场景不被破坏。
12. 作为使用者，我想补记目标分支只影响 MR 目标，**不重命名、不推送、不动分支指针**，这样我在别处的工作副本不被扰动。

### 变更可见性与错误处理

13. 作为使用者，我想回写失败（如远端不可达、并发改动）时留在界面上看到原因，而不是静默失败。
14. 作为使用者，我想补记是**幂等**的：重复设成同一个分支不产生副作用。
15. 作为维护者，我想这条写入路径集中在 `update_*` 命令里（不在前端直接改 `deliveryPlans` 状态冒充成功），这样磁盘与内存不会分叉。

---

## Implementation Decisions

- **新增命令** `update_delivery_plan_target(project_id, plan_id, target_branch) -> DeliveryPlan`，落在 `src-tauri/src/delivery_plan.rs`，并在 `src-tauri/src/lib.rs:512-524` 的 `invoke_handler!` 处注册。
- **校验**（与 `create_delivery_plan` 同口径，不引入新规则）：
  - `target_branch` trim 后非空；
  - `target_branch != batch.branch`（复用 `delivery_plan.rs:169` 的「源分支不能与目标分支相同」判据）；
  - 计划存在且 `status == "active"`（`review` / `merged` / `closed` 一律拒绝，给出原因）；
  - 目标分支**存在性**：校验其在本地或远端 ref 中存在（复用 `remote_branch_exists` / `local_branch_exists`），把拼写错误挡在写入前。**已实现为硬校验（fail-closed）**：本地或远端都查不到即拒绝；远端探测出错（网络 / 路径异常）也拒绝并给出原因，不静默放行——放行会让拼写错误推迟到 push 时才暴露成一条发不出的 MR。
- **写入范围**：只改 `batch.target_branch`，**不**重命名分支、**不** push、**不**改 worktree。分支名里的目标段是**创建时**的产物（`delivery_plan.rs:75-102`），事后改目标只影响 MR 目标——这一点写进命令注释与手册，避免「改了目标但分支名没变」被当成 bug。
- **持久化**：复用 `load_project_batches_sync` / `save_project_batches_sync`（`codeup.rs:1028-1040` 已示范同一读-改-写模式，含 `ok_or_else(|| "DeliveryPlan not found")`）。
- **前端**：分支行的目标段改为可编辑控件。样式按 `AGENTS.md` 规范进 `src/styles/`（含 `delivery-plan` 模块），**禁止** `style={{}}` 新写内联；选择器用既有 `SelectField` / Radix popover（不引原生 `<select>`）。
- **状态来源单一**：回写成功后用命令返回的 `DeliveryPlan` 替换本地列表项（复用 `PlanPanel.tsx:273` 的 `onDeliveryPlansChange(deliveryPlans.map(...))` 模式），不做乐观更新。
- **数据 schema 不变**：`target_branch` 字段已存在于 `src/types.ts:139`（`DeliveryPlan.targetBranch`）与 `src-tauri/src/storage.rs:257`，本次**无新字段**，无需迁移。
- **不做**：创建对话框必填化、「发起合并」视图改动、批量补记、计划其它字段的编辑（除方向 C 被采纳）。

---

## Scope — 影响面

- **动**：
  - 后端 `src-tauri/src/delivery_plan.rs`（新增更新命令 + 校验）、`src-tauri/src/lib.rs`（注册）。
  - 前端 `src/components/delivery-plan/PlanPanel.tsx`（分支行目标段可编辑、禁用按钮补 `title`）、新增的子组件若拆出则进 `src/components/delivery-plan/`（该目录已是子目录，符合「下沉」规范）、`src/components/branch-batch/SubmitMrDialog.tsx`（静默 return 补提示）、`src/styles/`（对应样式）。
- **不动**：`codeup_create_mr` / `merge_delivery_plan` 的拦截语义（继续守住空目标）、MR 创建与合并流程、`create_delivery_plan`（保留留空语义）、storage schema、终端写入链路。
- **不触及终端性能红线**：与 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路零交集。
- **对现有功能的回归风险**：低—中。
  - 需回归：测试 `src/test/plan-panel-actions.test.tsx:89`「worktree 缺失时提交 MR 禁用」仍成立；
  - 需回归：`4508679` 的「留空 = 暂不指定合并目标」在**创建**侧不回潮；
  - 需新增：一条把本次 repro 转正的回归测试——`targetBranch` 为空时可补记 → 按钮解禁 → 提交链路打通。
- **数据兼容**：纯新增命令 + 前端增强，存量 `batches.json` 无需迁移。

---

## 实现结果（2026-09-24）

按**方向 A + B** 落地，未纳入方向 C（通用「更新计划」命令）。

### 改动清单

| 文件 | 改动 |
|------|------|
| `src-tauri/src/delivery_plan.rs` | 新增 `update_delivery_plan_target` 命令 + 纯校验函数 `validate_target_branch_update`；2 条单元测试 |
| `src-tauri/src/lib.rs` | 注册命令 |
| `src/components/delivery-plan/TargetBranchEditor.tsx` | 新增：分支行目标段的可点编辑器（本地 ∪ 远端分支选择，选中即回写） |
| `src/components/delivery-plan/PlanPanel.tsx` | 分支行接入编辑器；`submitMrBlockReason` 统一「禁用判据 + 悬停原因」；禁用按钮外层 span 承载 `title` |
| `src/components/branch-batch/SubmitMrDialog.tsx` | 空目标的静默 `return` 改为可见错误提示（兜底） |
| `src/styles/delivery-plan.ts` | 编辑器与包裹层样式（无内联样式） |
| `docs/operation-manual.{html,md}` | 分支行 / 动作行 / 字段表三处文档同步 |
| `src/test/plan-target-branch-edit.test.tsx` | 新增 4 条回归测试 |

### 与提案的差异

- **存在性校验取硬校验（fail-closed）**，不保留「目标分支尚未创建」弹性；探测出错也拒绝并说明原因。
- 禁用的「提交 MR」补 `title` 时发现：禁用按钮不派发 hover，`title` 必须挂在**外层包裹 span** 上才生效——这是原「点了没反应」的放大器之一。

### 验证

- 反馈回路：修复前 repro 测试红（`disabled=true / title=null / 弹层不打开`）；修复后绿。
- `cargo test --lib`：358 passed（含新增 2 条）；`cargo check` 无 error。
- `vitest run`：575 passed（含新增 4 条）；`tsc --noEmit` 与 `eslint --max-warnings 0` 均通过。
- 运行中应用（`tauri dev` + WebView2 CDP）端到端实测：空目标 → 按钮禁用且给出悬停原因 → 分支行点开选择器（78 个真实分支，远端 `origin/` 前缀已正确剥离）→ 补记后按钮解禁；四类拒绝路径（空值 / 源=目标 / 拼写错误 / 非 active）逐一验证；远端独有分支名（如 `develop-old`）可正常选中。
- 截图：`plan-target-backfill-dark.png`、`plan-target-backfill-light.png`、`plan-target-backfill-picker-dark.png`。
