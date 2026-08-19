# 需求：云效议题过滤 v2 ——「我负责的」+ 状态多选 + 搜索下钻到服务端

> 状态：**需求文档（待评审）**——issue-first 提案，等 maintainer 明确批复后进入实现。
> 仓库：https://github.com/Alohazzz/nezha
> 承接：`docs/proposals/yunxiao-issues-integration-v1.md` 附录 B 的 **R3**（服务端过滤：状态/负责人，替代本地搜索）。

---

## 背景事实

- 云效 `SearchWorkitems` 的 `conditions` 参数（JSON 字符串，`conditionGroups` 结构）支持服务端过滤，
  同一条件组内为 **AND** 关系；`category`、分页、`orderBy` 等是独立参数，与 `conditions` 并存。
  本仓库后端 `yunxiao_search_workitems` 已接收 `conditions`，**前端目前未传值**（v1 一直传默认空条件）。
- 过滤字段（参考社区实测 cookbook + yunxiao-cli 调研文档，**实现时需用真实 token 复验**）：
  - 状态多选：`{ className: "status", fieldIdentifier: "status", format: "list", operator: "CONTAINS", value: ["<statusId>", ...] }`
  - 负责人：`{ className: "user", fieldIdentifier: "assignedTo", format: "list", operator: "CONTAINS", value: ["<userId>"] }`
  - 标题：`{ className: "string", fieldIdentifier: "subject", format: "input", operator: "CONTAINS", value: ["<keyword>"] }`
- 当前用户：文档路径 `GET /oapi/v1/platform/user`（获取令牌所属用户，返回用户对象）；
  **实现时需实测确认**，失败则走手动兜底（见附录 A）。
- 状态全集：云效状态按**工作项类型**维度组织，需先 `ListWorkitemTypes`（按 category）拿类型 ID，
  再逐个 `GetWorkitemWorkflow` 拿该类型全部状态（`id / name / displayName`），最后按分类合并去重。

---

## What — 你的想法

在「云效议题」列表上新增两个过滤条件，并把现有标题搜索从客户端挪到服务端，
统一走 `conditions` 查询：

1. **「我负责的」**：一个可切换的过滤按钮（高亮=开启），只显示 `assignedTo` 为当前用户的议题。
2. **状态多选**：下拉弹层 + 复选框列表，可多选状态；空选 = 不加状态条件（等价全部）。
3. **标题/编号搜索**：从「只过滤已加载页面」改为服务端 `subject CONTAINS`（行为修正，见 Why）。

**核心交互（低保真）：**

```
┌─ 云效议题（全屏视图）────────────────────────────────────┐
│ ← 返回   云效议题    [刷新] [重新连接]                     │
│ Hsp 2.0 · 云南达远软件有限公司                            │
│ ┌───────────────┬────────────┬──────────┬───────────┐   │
│ │ 全部│需求│任务│缺陷 │ [我负责的] │ [状态▾] │ 🔍搜索  │   │
│ └───────────────┴────────────┴──────────┴───────────┘   │
│  状态多选弹层（Radix Popover + 复选框）：                  │
│  ┌──────────────────────────────────────┐               │
│  │ ☑ 待处理   ☑ 进行中   ☐ 已完成   ☐ 已关闭 │               │
│  │ …                                    │               │
│  │                         [清空]        │               │
│  └──────────────────────────────────────┘               │
│ QHDK-29728 【芒市医共体】试剂出库查询…                    │
│   待处理 · 高 · 许宏民 · 2026-08-18          [导入]        │
│ QHDK-29727 医保主表合同单位回写不匹配…                    │
│   待处理 · 高 · 宋源波 · 2026-08-18          [导入]        │
│ …（分页：加载更多；总数 = 过滤后的 x-total）              │
└──────────────────────────────────────────────────────────┘
```

**过滤组合语义：** 分类 Tab（category）×「我负责的」× 状态多选 × 标题搜索，全部 **AND**；
任一条件变化即重新请求第 1 页并重置「加载更多」。状态选项跟随分类 Tab
（「全部」= Req/Task/Bug 状态并集，按状态 ID 去重；具体 Tab 只显示该类状态）。

### 功能清单（v2）

1. **服务端过滤管线**：前端把当前搜索词 + 我负责的 + 状态多选拼成 `conditions` JSON，
   传给现有 `yunxiao_search_workitems`；搜索输入防抖 ~250ms 触发，过滤按钮/多选即时触发。
2. **当前用户识别**：进入议题页时若设置中无缓存用户 ID，调用 `/platform/user` 自动识别并
   随 `save_yunxiao_settings` 缓存（新增 `currentUserId` / `currentUserName`）；
   识别失败时「我负责的」按钮禁用并在 tooltip 提示到连接表单手动填写兜底 ID。
3. **状态选项**：新增后端命令 `yunxiao_list_workitem_statuses`（类型 → 工作流 → 合并去重），
   按项目 + 分类组合缓存（内存缓存，切换项目/分类时按需取）。
4. **持久化**：`localStorage` 按项目记住「我负责的」开关与状态多选（`nezha:yunxiaoFilters:<projectId>`）；
   搜索词不记。
5. **多选控件**：`StatusMultiSelect` 用 Radix Popover/DropdownMenu + 复选框列表，
   触发器显示「全部状态」或「状态：N 项」，带「清空」快捷项。

### 明确不做（v2 非目标）

- 不加迭代/优先级/创建人等更多过滤（后续候选）。
- 不做客户端过滤兜底：过滤全部走服务端，客户端只做展示层。
- 不写回云效、不做议题详情页（沿用 v1 边界）。

---

## Why — 动机和原因

**痛点场景：** 云效项目里议题量大（Hsp 2.0 等），v1 只能靠「分类 Tab + 本地搜索」浏览。
用户日常最关心的是「我负责的、还没完的」议题，当前必须一页页翻找；状态过滤需求明确
是**多选**（如「待处理 + 进行中」一起看），单一状态 Tab 或单选都表达不了。

**当前体验的问题：**

- 本地搜索只作用于**已加载的页面**（每页 100、按需加载更多），结果漏掉未加载的议题，
  且「加载更多」后筛选结果会突变；
- 没有任何按负责人/状态定位议题的手段，翻页成本高；
- 计数 `x-total` 反映的是未过滤总量，用户无法感知筛选后的真实数量。

**期望行为：** 勾选「我负责的」+ 多选几个状态，列表只显示符合条件的全部议题（总数正确、
翻页正确、可继续导入）；搜索词与过滤条件 AND 组合，作用域同样覆盖全部议题。

**为什么优于其他备选：**

- 优于「客户端过滤」：客户端只能过滤已加载页面，与分页/总数天然矛盾（Q1 已否决）；
- 优于「先拉全量再本地过滤」：云效接口逐页拉全量代价高、不可控（页数无上限），
  服务端过滤把压力交给云效，Nezha 只拉最终结果页；
- 优于「只加状态不过滤负责人」：负责人是用户最高频的定位维度（「我的活」），
  与状态多选组合后正好覆盖「我负责的待办」这一核心工作台场景；
- 搜索顺带下钻服务端，是把「只搜已加载」这个 v1 已知局限一并修掉，避免同一个列表里
  两种过滤作用域不一致的割裂体验。

---

## Scope — 影响面

### 后端（Rust，`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `src-tauri/src/yunxiao.rs` | 新增 `yunxiao_get_current_user`（`GET /oapi/v1/platform/user`）、`yunxiao_list_workitem_statuses`（ListWorkitemTypes → GetWorkitemWorkflow → 按分类合并去重）；`yunxiao_search_workitems` 不改（conditions 已支持） |
| `src-tauri/src/app_settings.rs` | `YunxiaoSettings` 新增可选 `currentUserId` / `currentUserName`（`serde(default)` 兼容旧数据）；`save_yunxiao_settings` 接收并持久化 |
| `src-tauri/src/lib.rs` | 注册 2 个新命令 |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `src/components/app-settings/types.ts` | `YunxiaoSettings` + `EMPTY_YUNXIAO_SETTINGS` 同步新增 `currentUserId?` / `currentUserName?` |
| `src/components/yunxiao/YunxiaoView.tsx` | 状态：`assignedToMe` / `selectedStatusIds` / `statusOptions` / `currentUserId`；`buildConditions()` 拼 conditions；搜索与过滤任一变化重置 page=1 重查；当前用户与状态列表按需拉取 + 缓存；localStorage 读写过滤偏好 |
| `src/components/yunxiao/StatusMultiSelect.tsx`（新增） | Radix Popover/DropdownMenu + 复选框列表 + 清空，触发器显示「全部状态」/「状态：N 项」 |
| `src/components/yunxiao/YunxiaoConnectForm.tsx` | 「我的用户 ID/姓名」手动兜底输入（自动识别结果预填） |
| `src/styles/yunxiao.ts` | 过滤按钮（含 active 态）、下拉弹层、复选框项样式；不写 inline style |
| `src/i18n.tsx` | en/zh：我负责的 / 全部状态 / 状态：N 项 / 清空 / 无法识别当前用户等文案 |

### 数据 / 迁移

- `YunxiaoSettings` 新增两个可选字段，旧 `settings.json` 无字段，`serde(default)` 兼容，无迁移脚本。
- 过滤偏好存 `localStorage`（按 projectId 隔离），非核心数据。

### 安全

- 沿用 v1：token 只存本地设置、不进日志；响应域名白名单校验；命令不接收任意 URL。
- 新增命令只接受 `organizationId` / `projectId` / `token`（字符串），无路径参数，无目录遍历面。

### 不触及

- 终端性能红线：不改 `TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路。
- 不新增全局事件广播；议题数据仍按需 invoke。
- 列表仍按页加载（每页 ≤100），不引入虚拟滚动。

---

## 交互状态覆盖（PR 截图要求）

默认（全不过滤）/「我负责的」开启 / 状态下拉展开 / 已选多个状态 / 筛选后空态 /
过滤后计数与列表变化 / 无法识别当前用户（按钮禁用态）/ 暗色 + 亮色主题各一张。

---

## 附录 A：Grill 会话已确认决策

1. **过滤位置**：全部走服务端 `conditions`；任一过滤变化重置第 1 页重查。不做客户端过滤。
2. **「本人」识别**：进入议题页用已存令牌调 `/platform/user` 自动识别用户 ID，
   缓存进 `YunxiaoSettings`；接口失败时在连接表单手动指定兜底。
3. **状态选项来源**：完整状态列表（ListWorkitemTypes → GetWorkitemWorkflow → 合并去重），
   按项目缓存；选项跟随分类 Tab（全部 = 三类并集）。
4. **状态多选语义**：空选 = 不加状态条件（全部）；触发器显示「全部状态」或「状态：N 项」；
   带「清空」。切换分类后保留已选状态，查不到就显示空态，不自动清空。
5. **搜索行为**：标题搜索搬进服务端（`subject CONTAINS`），与负责人/状态 AND 组合；
   这是把 v1「只搜已加载」局限修正为「搜全部」，属行为修正，issue 中明示。
6. **持久化**：按项目记住「我负责的」+ 状态多选（localStorage）；搜索词不记。
7. **UI 形态**：「我负责的」为可切换按钮（默认关）；状态下拉用 Radix Popover + 复选框，
   不用原生 select（仓库规范），不用 Radix Select（不支持多选）。

## 附录 B：待评审 / 后续迭代候选

- **R1** 迭代/优先级/创建人过滤（同样走 conditions，可复用本方案的状态列表管线）。
- **R2** 「我负责的 + 未完成状态」一键组合快捷筛选（如「我的待办」预设）。
- **R3** 过滤条件持久化到项目配置而非 localStorage。
- **R4** 云效写回（任务完成 → 议题流转），延续 v1 附录 B R1。

## 附录 C：验证清单（开发完成时）

- [ ] `cargo check` / `pnpm build`（tsc）/ `pnpm test` 通过
- [ ] 真实 token 复验 conditions 语法：`status CONTAINS`（多值）、`assignedTo`、`subject CONTAINS`
- [ ] `/platform/user` 实测：正常返回时自动识别；异常时按钮禁用 + 手动兜底可用
- [ ] 状态列表：跟随分类 Tab 变化；全部 = 并集去重；缓存生效（切换 Tab 不重复请求）
- [ ] 过滤后总数/分页/「加载更多」正确；空结果显示空态
- [ ] 搜索防抖生效；搜索 + 过滤组合 AND 正确
- [ ] localStorage 按项目记住过滤偏好；搜索词不持久化
- [ ] 暗色/亮色主题截图齐全

