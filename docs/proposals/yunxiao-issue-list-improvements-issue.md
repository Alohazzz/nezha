# 提案 issue 草稿（Yunxiao issue list improvements）

> 目标仓库：`hanshuaikang/nezha`（上游）。标题待定，正文如下。

## 标题

```
feat(yunxiao): colored status badges, product & plan-end-date filters, toolbar regroup
```

## 正文

### What — 想法

云效议题列表（YunxiaoView）四项改进：

1. **议题状态徽标彩色化**：现在状态只是灰底文字片，改为按云效官网工作流配色分四档着色——
   - 蓝：待处理 / 待确认 / 已确认
   - 绿：待开发 / 开发中 / 开发完成 / 待测试 / 测试中 / 测试完成
   - 橙：测试打回 / 发布中 / 验收完成 / 触发重置 / 发布完成
   - 灰：已完成 / 已创建 / 已拒绝 / 已取消 / 已关闭（及未匹配状态回落）
   - 亮/暗主题（light / dark / midnight / eyecare）各自适配色值。

2. **所属产品过滤**：新增产品多选过滤器。产品候选优先来自云效产品列表 API；接口不可用时降级为「从已加载议题去重」并在下拉里提示。conditions 走 `product CONTAINS` 服务端过滤。产品名同时展示在议题卡片 meta。

3. **计划完成时间过滤 + 展示**：
   - 字段为云效**自定义字段**，后端按名称「计划完成时间」查字段配置拿字段 ID（复用「价值评分」的缓存先例），值从 `customFieldValues` 读取。
   - 过滤交互：单选下拉（本周 / 本月 / 自定义），自定义内联起止日期输入；本周 = 周一起始自然周，本月 = 自然月。
   - 卡片展示时间徽标：早于今天且状态非终态（非 已完成/已拒绝/已取消/已关闭）标红（已逾期），终态保持灰。

4. **工具栏分组两行**：第一行 = 项目选择 + 分类 Tab + 创建计划按钮；第二行 = 过滤栏（我负责的 / 状态 / 产品 / 计划完成时间 / 版本）+ 搜索框 + 计数。删除现在独占一行的「创建计划」。

新过滤器选项按项目维度持久化到 localStorage，与现有状态/版本过滤器一致。

### Why — 动机

- 状态是议题当前阶段最高频的信息，纯灰文本无法一眼区分「进行中 / 打回 / 已完成」，扫列表效率低；云效官网本身有成熟的四色配色语言，跟随它零学习成本。
- 「所属产品」是多产品项目里定位议题的第一维度，目前只能靠搜索或翻页。
- 计划完成时间是交付管理的关键字段，现在列表里完全不可见、不可筛；逾期无感知。
- 「创建计划」独占一行在列表上方形成一条几乎空白的横条，浪费纵向空间；分组两行后信息密度更高。

### Scope — 影响面

- 前端：`src/components/yunxiao/`（YunxiaoView / YunxiaoIssueList / YunxiaoFilterBar / useYunxiaoFilters / 新增 FilterSelect）、`src/utils/yunxiao.ts`（conditions 拼装）、`src/styles/yunxiao.ts`（新增状态 chip / 逾期样式 / 工具栏两行布局）、`src/types.ts`（Workitem 加 product、planEndDate 字段）。
- 后端：`src-tauri/src/yunxiao.rs`（Workitem 结构体加字段、自定义字段按名称找 ID + 缓存、产品列表命令）。
- 不触碰终端链路（TerminalView / useTerminalManager / pty.rs），不涉及终端性能红线。
- 兼容性：planEndDate / product 字段缺省时展示与过滤安静降级；新字段遵循 TS/Rust 结构体同步更新规范。

### 截图

（附改前现状截图 + 按四色系映射的状态徽标 mockup、工具栏两行布局示意，暗/亮主题各一份）
