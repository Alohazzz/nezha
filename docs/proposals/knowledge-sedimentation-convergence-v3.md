# 设计变更：知识沉淀两阶段收敛（v3）

> 状态：**已实现**（承接 #88 / #100）
> 日期：2026-09-28
> 提案：[#100](https://github.com/Alohazzz/nezha/issues/100)
> 取代：`knowledge-auto-sedimentation-v2.md` 的 §5.3 / §6.3 / §6.4 / §8.1 / §8.4（详见下）

## 为什么改

v2 决策是「**门通过即直写主干 + push，无人工把关**」（v2 附录 B #2 / #17）。实测暴露两个问题：

1. **回写黑盒**：门通过即写入并推送，用户看不到「将要写入什么」，无预览、无确认；而 L3 存在
   判定漂移（实测 1/3）、且「引用真实文件 + 纯中文断言」的虚构无法被确定性层识别 ⇒ 一次漏放即
   永久污染，只能靠 `git revert` 补救。
2. **设置项语义含混**：`knowledge.enabled` 同时兼任「是否产出」与「是否自动写入」两职，无法表达
   「要沉淀、但要人审后再入库」。

## 改了什么

### 1. 产出收敛到技能（两条通路同一契约）

- 新增 SkillHub 独立技能 `knowledge-sediment-now`：会话中手工触发（总结 → 预览确认 → 落
  `knowledge.json`），与任务收尾的自动产出共用同一份 `sedimentation.md` 契约。
- 写入格式收敛为**模板单一事实源** `knowledge-graph/references/sedimentation-template.md`
  （Nezha 读模板渲染，读不到回退内嵌默认）；顺带消除 v2 遗留的「人工条目来源内联 vs 自动条目
  独立依据行」两套格式并存。
- 「知识沉淀」设置**不再参与产出判定**：绑定图谱即产出（`should_inject_sediment_contract`
  只剩「绑定图谱 ∧ 本任务要求产出」两个条件）。

### 2. 回写改为「暂存 → 审核发布」

- 门通过的条目**只写入工作区、不再自动 commit / push**（`knowledge_stage_writeback`）。
- 审核发布统一收口到右侧「知识库」面板：**提交并推送**（确认发布）/ **全部丢弃**（还原）；
  工具条图标红点 + 卡片「已改」徽标提示待确认；卡片**预览态高亮新增条目**，编辑态保持原始文本。
- 复用面板既有基建（`list_modified_knowledge_cards` / `publish_knowledge_changes`），
  新增 `discard_knowledge_changes` / `count_pending_knowledge_cards` /
  `list_pending_knowledge_additions`。
- 发布前先同步远端（原 `push_pending_commits` 的写前 pull 职责迁移为
  `sync_graph_before_publish`，挂在 `publish_knowledge_changes` 上）。

### 3. 「知识沉淀」设置重定义为发布方式选择器

- **开启**（默认）：确认发布 = 直接提交并推送图谱。
- **关闭**：确认发布 = 创建云效审核议题（`yunxiao_create_knowledge_issue`），人工审核后更新图谱。
- 不再通过 prompt 方式触发自动回写；回写一律经面板审核发布。

### 4. 退役与清理（删除而非注释）

| 项 | 处理 |
|---|---|
| `push_pending_commits` 及其 `#[ignore]` 实测用例 | 删除（暂存语义下无待推提交可补） |
| 自动 commit + push 尾段 | 删除，改由面板 `publish_knowledge_changes` 承担 |
| `pushed_pending` 字段链（Rust / types.ts / 结果弹窗） | 删除；指标字段改为 `trigger: auto\|manual` |
| `KnowledgeWritebackResult.commit` | 删除 |
| RunningView `done` 后「沉淀结果」按钮 + 结果弹窗接线 | 删除；结果明细移到面板「最近一次判定结果」入口 |
| `save_knowledge_auto_writeback` 废弃别名 | 删除（前后端同版发布，无兼容负担） |
| `knowledge_auto_writeback` 命令名 | 改名 `knowledge_stage_writeback`（语义已变） |
| `dirty_module_cards` 脏卡检测 | 删除——暂存语义下「未提交」是常态，该检测会把第二批候选全部误拒；写入是「读当前 → 末尾追加」，不覆盖人工改动，重复由 L2/L3 去重兜底 |

### 5. 保留项

- 四层质量门（L0/L1/L2/L3）与「宁缺毋滥」取向**不变**，仍是第一道防线。
- 失败出口：产物缺失 / 整轮未完成仍建云效议题；「门全拒」不再告警（可在面板看逐条理由）。
- 幂等：重复处理同一产物，已写入条目被去重层拒。
- 指标：`~/.nezha/knowledge-metrics.jsonl`，`trigger` 区分自动 / 手工（旧记录回落 `auto`）。

## 对 v2 的取代关系

| v2 章节 | 状态 |
|---|---|
| §5.3「不做取代语义、冲突一律拒」 | **保留**（门未变） |
| §6.3 commit / push 契约 | **取代**：不再自动提交，改面板发布 |
| §6.4「重试先补推」 | **取代**：暂存语义下无此场景，相关代码删除 |
| §8.1「任务完成即自动处理、无手动入口」 | **部分取代**：自动触发保留，但结果改为「待确认」而非直写；另增手工技能入口 |
| §8.4「移除 autoWriteback，保留总开关」 | **取代**：开关不再是「总开关」，改为发布方式选择器 |
| §9.2 指标 | **调整**：`pushed_pending` → `trigger` |
| §11 实施进度 | 第 1~6 步的产物仍成立（门、契约、hub 拉取、环境变量注入），第 5 步的前端形态被本次重做 |

## 验证

- 后端：`cargo test --lib`（372 passed；模板渲染 / 校验、指标 `trigger` 向后兼容均有新用例）。
- 前端：`npx vitest run`（602 passed）；新增 `markdown-highlight.test.ts` 覆盖预览高亮。
- 类型：`npx tsc --noEmit` 通过；`npx eslint` 改动文件无告警。
