# 需求：云效议题知识沉淀 —— 讨论完成后提取图谱增量，创建云效审核议题（v1）

> 状态：**需求文档（待评审）**——grilling 决策树已走完，进入 issue-first 提案流程。
> 仓库：https://github.com/Alohazzz/nezha（本地 remote 实测）
> Issue：#12（https://github.com/Alohazzz/nezha/issues/12）
> 承接：`his-knowledge-graph` 技能（HSP-SkillHub）已把知识图谱数据纳入技能目录 `data/`
> 并随技能仓库 git 统一管理；本迭代补齐「讨论后 → 知识沉淀 → 人工审核」的上游环节。

---

## 背景事实（代码/环境查证）

- 知识图谱数据：`HIS/.codex/skills/his-knowledge-graph/data/`（index.md、modules/<模块>.md、
  graph.json），模块卡片为六段结构：定位 / 职责 / 关键实体与数据表 / 依赖与相关模块 /
  业务规则与已知坑 / 验证记录；未填充字段标注「（待补充…）」。
- 云效侧现有命令：`yunxiao_create_workitem_comment`（评论）等只读/评论能力，
  **没有创建议题（CreateWorkitem）命令**；目标项目「知识库图谱」
  （id `bc826ccda665f0718511440fac`）已存在，用于承载审核议题。
- 已有可复用链路：`generate_yunxiao_writeback_summary`（headless agent + 会话摘要截断 +
  git 事实骨架 + 预览弹窗）；「回写云效」按钮 + 幂等字段 `yunxiaoWrittenBackAt` / `yunxiaoCommentId`。
- 技能仓库（HSP-SkillHub）与技能编写约束已就绪：`scope` / `project` / `build-command`
  frontmatter、技能目录 `data/` git 管理、`NEZHA_SKILL_DATA_DIR` 环境变量注入。

---

## What — 你的想法

云效议题经 Agent 讨论/修改完成后，新增「知识沉淀」环节：

1. **入口**：云效导入任务 `done` 后，RunningView「回写云效」旁新增「沉淀知识」按钮；
   点击后弹出预览弹窗。
2. **提取**：headless Agent 按 `knowledge-sedimentation` 技能规则，基于
   会话摘要（8000 字截断）+ 云效议题补充字段/链接 + 知识图谱数据目录（现场比对）+
   项目代码（`rg` 验证依据），识别「有价值且图谱中没有」的知识，输出标签化 JSON
   （每条：`module / section / content / evidence / confidence / suggestedTitle`）。
3. **判定标准**：按卡片六段骨架提取——业务规则/已知坑 > 关键实体/表映射 >
   职责修正/依赖补充 > 验证记录；门槛 = 有依据（代码/文档/用户确认）；
   排除卡片已有内容、无依据猜测、纯实现细节；每条带置信度（已确认/待验证）。
4. **预览**：弹窗列表展示候选知识，逐条可编辑、可勾选；点「创建所选议题」批量创建。
5. **议题格式**：每条知识一个议题，创建到「知识库图谱」项目（Req，默认字段）：
   - 标题：`【知识沉淀】<模块id>-<知识点摘要>`
   - 描述：来源议题（编号+链接）→ 目标模块卡片 → 建议更新段落 → 具体内容
     （按 module-card-guide 写法）→ 依据 → 置信度 → 审核指引
6. **去重与幂等**：创建前按标题关键词搜索「知识库图谱」项目已有议题，命中则不重复创建；
   创建成功后 Task 记录 `knowledgeIssueIds`，按钮转「已沉淀」。
7. **边界**：本迭代到「创建审核议题」为止；审核通过后的图谱数据更新由知识库负责人
   人工更新 `data/modules/<模块>.md` 并 commit + push（自动应用留后续迭代）。

### 技能（`knowledge-sedimentation`，HSP-SkillHub）

- `scope: project` / `project: HIS`；SKILL.md 承载提取规则、云效议题模板、标签化输出格式；
- 与 his-knowledge-graph 解耦（一个管「读图谱/维护」，一个管「沉淀出审核议题」）；
- Nezha 在「沉淀知识」触发时读取该技能内容注入 headless prompt；技能同时装进项目可手动调用。

### 明确不做（v1 非目标）

- 不做「审核通过 → 自动更新图谱数据」（审核语义未定，后续迭代）；
- 不做自动触发（保持手动按钮 + 预览）；
- 不做 agent 直接调云效 API（token 由 Nezha 后端持有）。

---

## Why — 动机和原因

**痛点场景：**

- Agent 讨论/修改议题时确认了大量有价值信息（业务规则、已知坑、实体/表映射、职责修正），
  但都散落在会话里，没人回填知识图谱——知识随会话流失，下次同类议题还要重新盘问；
- 知识图谱的 `data/` 是 git 管理的受审资产，不能让 Agent 直接改（无审核、无依据门槛），
  但也没有一个「把候选知识送审」的通道。

**期望行为：**

讨论完成后一键沉淀：Agent 按规则比对图谱、提取有依据的增量，格式化为云效审核议题
（「知识库图谱」项目），人工逐条审核后由负责人更新图谱——知识入库有依据、有审核、
有追溯。

**为什么优于其他备选：**

- 优于「讨论时让 Agent 直接写图谱」：无审核、无法保证依据，污染 git 受审资产；
- 优于「人肉整理」：Agent 讨论中确认的知识最鲜活，事后人工回忆会丢失细节；
- 优于「自动创建不预览」：识别质量不稳定，预览+可编辑是质量闸门，避免审核队列塞垃圾；
- 复用「回写云效」的交互与后端模式（headless + 预览 + 幂等），改动面收敛。

---

## Scope — 影响面

### 技能仓库（HSP-SkillHub）

| 内容 | 说明 |
|------|------|
| `knowledge-sedimentation/SKILL.md`（新增） | 提取规则（六段骨架 + 依据门槛 + 置信度）、云效议题模板、标签化输出格式 |

### 后端（`src-tauri/`）

| 模块 | 改动 |
|------|------|
| `yunxiao.rs` | 新增 `yunxiao_create_workitem`（CreateWorkitem，token 后端持有，真实 token 复验路径/返回结构）；`yunxiao_search_workitems` 复用做去重搜索（限定「知识库图谱」项目 + 标题关键词） |
| `agent_assist.rs` | 新增 `generate_knowledge_sedimentation`：读取 `knowledge-sedimentation` 技能内容 → 拼 headless prompt（会话摘要 + 议题信息 + 图谱目录 + 项目根）→ 标签化 JSON 解析（复用超时/kill_on_drop/路径校验） |
| `storage.rs` / `types.rs`（Rust Task） | Task 新增 `knowledge_issue_ids: Vec<String>`（serde default 兼容旧数据） |
| `lib.rs` | 注册新命令 |

### 前端（`src/`）

| 模块 | 改动 |
|------|------|
| `types.ts` | Task `knowledgeIssueIds`；`KnowledgeSuggestion` 等类型 |
| `RunningView.tsx` / `ProjectPage.tsx` | 「沉淀知识」按钮（done 且云效导入时）+ 弹窗状态 |
| 新增 `KnowledgeSedimentationDialog`（`src/components/yunxiao/`） | 候选列表（模块/段落/内容/依据/置信度）、逐条编辑、勾选、批量创建 |
| `styles/yunxiao.ts` / `i18n.tsx` | 弹窗样式与 en/zh 文案 |

### 安全

- `yunxiao_create_workitem` 只接收字符串参数（token/org/project/category/subject/description），
  无路径参数；token 不进日志；域名白名单复用 `read_json_body`。
- headless 调用沿用 `project_path` canonicalize 校验。

### 不触及

- 终端性能红线；不新增全局事件广播；
- 不改变 `his-knowledge-graph` 技能与图谱数据管理（data/ git 管理保持不变）。

---

## 验证

- `cargo check` / `cargo test`、`pnpm build` / `pnpm test` / `pnpm lint` 通过；
- 真实 token 复验 `CreateWorkitem` 路径与返回结构（仓库惯例）；
- 端到端：完成一个云效任务 → 沉淀知识 → 预览 → 创建审核议题 → 去重（重复点击不重复建）→
  Task 记录 `knowledgeIssueIds` → 按钮「已沉淀」；
- UI 状态覆盖：生成中 / 空结果 / 有候选 / 已存在去重 / 创建失败 / 已沉淀，暗色+亮色截图。

---

## 附录 A：Grill 会话已确认决策

1. **触发**：任务 done 后手动「沉淀知识」按钮 → 预览 → 创建（不自动）。
2. **判定标准**：按卡片六段骨架 + 依据门槛 + 置信度（业务规则/坑 > 实体/表 > 职责/依赖 > 验证记录）。
3. **议题格式**：每条知识一个议题 + 固定模板，创建到「知识库图谱」项目（Req）。
4. **创建与去重**：Nezha 后端 `yunxiao_create_workitem`（token 不暴露给 agent）；创建前标题关键词搜索去重；Task 记录 `knowledgeIssueIds`。
5. **技能形态**：HSP-SkillHub 新建 `knowledge-sedimentation`（scope project / project HIS），
   Nezha 读技能注入 headless prompt。
6. **输入范围**：会话摘要（8000 截断）+ 议题信息 + 图谱目录比对 + 项目根代码验证。
7. **闭环边界**：本轮到创建审核议题；审核后图谱更新人工执行（自动应用留后续迭代）。
8. **预览交互**：列表预览 + 逐条可编辑 + 勾选批量创建。
