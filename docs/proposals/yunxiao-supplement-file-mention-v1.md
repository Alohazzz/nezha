# 需求：云效议题内容补充界面支持 @ 引用文件路径（v1）

> 状态：**需求文档（待评审）**——grilling 决策树已走完，进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha
> 承接：`docs/proposals/yunxiao-issue-detail-v2.md`（详情/补全页）与
> `docs/proposals/yunxiao-v3-close-loop-and-images.md`（识图/回写闭环，同页共存）。

---

## 背景事实

- v2 详情页（`src/components/yunxiao/YunxiaoIssueDetailView.tsx`）的补充表单字段是普通
  `<input>` / `<textarea>`，值存 `Task.yunxiaoSupplement.fields`（`Record<string,string>`），
  定稿时由 `buildSupplementedPrompt` 拼成纯文本 prompt；**字段值必须是纯字符串**。
- 现有 @ 引用文件路径只存在于新任务视图：`PromptEditor`（contentEditable + chip）+
  `MentionPopover` + `list_project_files`（git ls-files，返回**相对路径**）。
  同项目 chip 序列化为 `@相对路径`（如 `@src/App.tsx`）。
- AGENTS.md 硬性约束：@ 提及搜索在万级文件项目必须防抖（200ms）或 `startTransition`；
  且仓库要求 issue-first——先开提案 issue 等批复，再写代码。
- `search_project_files` 服务端过滤返回**绝对路径**（需剥前缀才能转相对路径）；
  `list_project_files` 返回**相对路径**，可直接作插入文本。
- `mentionDropdown` 样式为 `position:absolute; bottom:calc(100% + 6px); zIndex:200`，
  依赖外层 `position:relative` 容器；详情页滚动容器 `yunxiaoDetailBody` 是
  `overflowY:auto`，首字段浮层向上展开可能被滚动区顶部裁切。

---

## What — 你的想法

在云效议题详情页的「议题内容补充」表单里，**所有字段**（标题 input + 全部 textarea）
输入 `@` 时弹出当前项目的文件候选浮层，选中后把 `@query` 替换为 `@相对路径` 纯文本。

**核心交互（低保真）：**

```
┌─ 议题内容补充（需求）                          [AI 预填] ─┐
│ 标题        [任务列表加「只看 starred」筛选            ] │
│ 当前痛点    [starred 一多就淹没在列表里┌─────────────┐]  │
│             [                          │ src/App.tsx  │]  │
│             [                          │ src/utils/…  │]  │
│             [                          │ …            │]  │
│ 期望行为    [                          └─────────────┘]  │
│                                                      [定稿]│
└──────────────────────────────────────────────────────────┘
```

### 功能清单（v1）

1. **触发**：所有字段输入 `@`（光标前最后一个 `@` 开始、query 不含空格/换行）弹出浮层；
   与新建任务视图的触发规则一致。
2. **候选来源**：仅当前项目（`list_project_files(projectPath)` 相对路径），
   **首次触发 `@` 时懒加载**，按项目路径缓存，同项目后续秒开。
3. **过滤**：内存中按文件名/路径子串过滤，200ms 防抖或 `startTransition`
   （AGENTS.md 万级文件硬性要求），最多展示 8-12 条。
4. **选择**：键盘（↑/↓/Enter/Tab/Escape）+ 鼠标点击；选中后把 `@query` 替换为
   `@相对路径` 纯文本，光标落在路径后。
5. **浮层复用**：直接复用 `MentionPopover`（仅文件模式），跨项目相关 props 改可选。
6. **层级/定位**：字段外包 `position:relative` 锚点；浮层默认在字段上方，
   靠近滚动区顶部时自动翻转到字段下方，避免被 `yunxiaoDetailBody` 裁切。
7. **落点**：字段值保持纯字符串，`yunxiaoSupplement.fields` 数据模型、定稿拼 prompt
   逻辑**零改动**；`@相对路径` 自然进入讨论 prompt。

### 明确不做（v1 非目标）

- **不做跨项目 @**：仅当前项目（其他项目引用放后续候选）。
- **不做 chip/富文本**：纯文本插入，字段值保持 `Record<string,string>`。
- **不做服务端搜索**：不用 `search_project_files`（绝对路径需转换，且每次击键起子进程）。
- **不动新任务视图**：`PromptEditor` / 新任务里的 @ 行为保持不变。
- **不覆盖讨论区/只读区**：只有补充表单字段支持。

---

## Why — 动机和原因

**痛点场景：** 补充议题内容（当前痛点 / 复现步骤 / 期望行为等）时经常要引用具体文件，
现在只能手打路径。路径长、易打错（Windows 绝对路径尤其），Agent 拿到错误路径后
来回返工，一次会话被无谓消耗。

**期望行为：** 和新建任务输入框体验一致——`@` 触发、模糊匹配、键盘/鼠标选择、
选中即插入相对路径；定稿 prompt 里的文件引用格式与新建任务完全统一
（都是 `@相对路径`），Agent 无需适应两种写法。

**为什么优于其他备选：**

- 优于「手打路径」：消除打错/记忆成本，引用即所见；
- 优于「chip（contentEditable）」：最终进 prompt 的文本完全相同，但纯文本插入
  不需要字段值变 HTML、不需要每字段序列化/回填，改动量小一个数量级；
- 优于「新写浮层组件」：复用 `MentionPopover` 保证交互与视觉一致，单一真相源；
- 优于「服务端搜索」：相对路径直接可用，且 `list_project_files` 一次缓存即可，
  不会每次击键起 git 子进程；
- 优于「跨项目 @」：补充表单语义就是当前仓库的议题，跨项目引用没有真实场景，
  先不做，避免引入项目选择/懒加载一整套复杂度。

---

## Scope — 影响面

### 前端（`src/`，纯前端改动，无后端/无 schema）

| 模块 | 改动 |
|------|------|
| `src/components/yunxiao/YunxiaoIssueDetailView.tsx` | 字段外包锚点、接入浮层；**组件当前 413 行已超 400 行红线**，字段渲染/提及逻辑下沉到新文件，保持本组件 ≤400 行 |
| `src/components/yunxiao/FileMention.tsx`（新增） | `FileMentionField`：懒加载 + 按项目路径缓存 + 200ms 防抖过滤 + 触发/替换/翻转定位 + 字段锚点渲染 |
| `src/components/yunxiao/SupplementFields.tsx`（新增） | 补充表单字段渲染下沉（`YunxiaoIssueDetailView.tsx` 413 行 → ≤400 行） |
| `src/components/new-task/MentionPopover.tsx` | 跨项目相关 props 改可选（向后兼容）；新增可选 `placement: "above" \| "below"`（默认上方、近顶翻转下方） |
| `src/test/yunxiao-file-mention.test.tsx`（新增） | @ 引用交互测试：触发/过滤/选中插入/键盘/空格关闭 |
| `src/styles/yunxiao.ts` | 字段锚点（`position:relative`）、浮层翻转定位样式；候选/空态/加载样式复用 `panels.ts` 的 `mention*` |
| `src/i18n.tsx` | 优先复用 `mention.*` 文案；如有必要新增 `yunxiao.form.mention*` |

### 数据 / 迁移

- **无**。`Task.yunxiaoSupplement.fields` 仍是 `Record<string,string>` 纯字符串，
  无字段结构变化，无需迁移脚本。

### 安全

- 无新 Tauri 命令、无路径参数边界问题；沿用现有 `list_project_files` 的
  `project_path` 校验。

### 不触及

- 后端（`src-tauri/`）零改动；终端性能红线
  （`TerminalView.tsx` / `terminalShared.ts` / `useTerminalManager.ts` / `pty.rs` 写入链路）
  不涉及。
- 新任务视图 @ 行为、云效列表/过滤/回写流程均不动。

---

## 交互状态覆盖（PR 截图要求）

浮层触发（加载中 / 有结果 / 无结果 / 空查询）/ 键盘高亮 / 选中插入后 /
首字段翻转定位 vs 中部字段上方定位 / 未选中关闭后 `@query` 保留 /
暗色 + 亮色主题各一张。

---

## 附录 A：Grill 会话已确认决策

1. **插入形态**：纯文本插入 `@相对路径`，字段值保持纯字符串（方案 A）。
2. **字段范围**：所有字段统一支持（标题 input + 全部 textarea），不特判。
3. **搜索范围**：仅当前项目（`list_project_files` 相对路径）。
4. **搜索方式**：懒加载 + 内存过滤 + 200ms 防抖 / `startTransition`。
5. **浮层组件**：复用 `MentionPopover`，跨项目 props 改可选。
6. **层级/定位**：字段 `position:relative` 锚点；默认上方、近顶翻转下方；z-index 沿用 200。
7. **插入文本**：`@相对路径`，与新建任务 chip 序列化格式一致。
8. **小行为**：未选中关闭浮层时保留已输入的 `@query` 文本；文件列表按项目路径缓存；
   讨论区/只读区不支持 @。
9. **边界**：纯前端、无后端命令、无 Task schema 迁移。
10. **流程**：issue-first——先提案 issue 待 maintainer 批复（label `accepted` 或评论确认），
    再实现；PR 附截图（暗/亮主题 + 状态覆盖）。

## 附录 B：待评审 / 后续迭代候选

- **R1** 跨项目 @ 引用（复用 `NewTaskView` 的 otherProjects 逻辑）。
- **R2** 插入文本视觉高亮 / chip（需字段改 contentEditable，v1 明确不做）。
- **R3** 服务端搜索（`search_project_files`，绝对路径需剥项目根前缀）。
- **R4** 文件列表自动刷新（引用期间仓库文件变化）。

## 附录 C：验证清单（开发完成时）

- [ ] `pnpm build`（tsc）/ `pnpm test` 通过；`YunxiaoIssueDetailView.tsx` ≤400 行
- [ ] 触发：所有字段可用；空查询 / 无结果 / 加载态正确；query 含空格或换行时关闭浮层
- [ ] 选择：键盘 ↑/↓/Enter/Tab/Escape 与鼠标点击均正常；`@query` 被替换为 `@相对路径`
- [ ] 防抖：万级文件项目连续输入不卡顿（DevTools performance 简单验证）
- [ ] 翻转：首字段浮层不被 `yunxiaoDetailBody` 顶部裁切；中部字段浮层在字段上方
- [ ] 缓存：同项目切换待办后再次触发不重复 `list_project_files`
- [ ] 定稿：prompt 含 `@相对路径` 文本；`tasks.json` 持久化正确；重开详情页表单值不变
- [ ] 回归：新建任务视图 @ 行为不受 `MentionPopover` 重构影响
- [ ] 暗色/亮色截图齐全；加载/空/错误态覆盖
