# 设计规格：知识图谱自动沉淀（取代云效议题人工编辑）

> 状态：**设计规格（待评审）**——wayfinder 决策地图已走完（11 张 decision ticket 全部 resolved），可进入实现排期。
> 日期：2026-09-16
> 承接：`docs/proposals/yunxiao-knowledge-sedimentation.md`（v1：讨论完成 → 建云效审核议题 → 人工编辑图谱）。
> 本规格把 v1 的「人工审核在前」改为「**自动直写图谱主干、自动质量门把关**」。
> 决策依据：[`.scratch/knowledge-auto-sedimentation/map.md`](../../.scratch/knowledge-auto-sedimentation/map.md)（地图 + 11 张 ticket）
> 调研依据：[`docs/research/kg-consumption-freshness.md`](../research/kg-consumption-freshness.md)、[`docs/research/kg-semantic-dedup-options.md`](../research/kg-semantic-dedup-options.md)
> 实测依据：[`.scratch/knowledge-auto-sedimentation/assets/04/`](../../.scratch/knowledge-auto-sedimentation/assets/04/)（夹具 + 全部运行输出）

---

## 1. 背景事实（已查证，含实测）

### 1.1 现状链路

自动回写链路**已存在**（`abfdf46` + 修复 `3a3dbce`），但被两件事耦合住：

1. 它挂在 `autoWriteback` 开关后面，且**必须先创建云效议题**——`App.tsx:2903` 只有 `autoWriteback && result.created` 才调用 `knowledge_auto_writeback`；**议题去重命中会整体跳过回写**，所以重复点击沉淀 = 永远不回写。
2. 提炼是 post-hoc 的：任务结束后另起 headless 调用（`agent_assist.rs:1620`），输入只有 8000 字会话摘要，**没有主 agent 当场验证过的上下文**。

### 1.2 实测结论（本规格的关键依据）

用**生产真实 prompt + 真实 cwd + 真实 CLI**回放现有质量门（`assets/04/`）：

| 发现 | 数据 |
|---|---|
| **这条链路从未成功写入过任何东西** | 1079 条既有条目**没有一条**用过写入格式；hub git log 无 `auto sediment` 提交 ⇒ **改写入格式零迁移成本** |
| 规则层几乎无效 | 6 条候选（含 4 条已知重复）**全部放行**；原因是唯一的确定性去重是逐字子串匹配，**一个反引号即可击穿**（卡片 `` `SchedulId` `` vs 候选 `SchedulId`） |
| 门的语义判断力**是好的** | 4/4 重复、1/1 冲突、4/4 虚构依据全部正确拒绝；引用**逐行核验为真**；且**能放行**真·新知识 |
| **致命缺陷 A：撞自己的超时** | 实测耗时 80 / 140 / 157 / **436 s**，超时线 180 s；超时 ⇒ kill ⇒ `Err` 上抛 ⇒ **整批知识静默丢弃** |
| **致命缺陷 B：判定漂移** | 同一输入三次重跑，同一虚构条目「拒绝 / 拒绝 / **放行**」⇒ **1/3 漂移** |
| **内联卡片可快 20–80 倍** | 卡片内联进 prompt（不探索仓库）⇒ 5–20 s，**语义判定质量不变**；但**无法核实依据真伪**（虚构条目被放行） |
| 证伪 chart 时假设 | 门 prompt 的卡片路径虽写错，门读 `SKILL.md` 后自行找到卡片；错误路径与修正路径判定**完全相同**——缺陷真实但不致命 |

**由此得出规格的核心分界**：**依据核实必须由 Rust 确定性承担，语义判定才交给 LLM。** 二者不可兼得（能核实的慢，快的不能核实）。

### 1.3 消费侧新鲜度（`kg-consumption-freshness` 调研）

| 消费方 | 读哪份 | 陈旧源 |
|---|---|---|
| Codex agent（讨论/执行） | 经技能自解析 `knowledge-graphs/<id>/data/index.md` → `modules/<m>.md` | hub 落后 origin |
| 右侧「知识库」面板 | `data/modules/*.md` 实时读盘 | 无（但不监听图谱变更） |
| 自动回写 | 只 append `modules/*.md`，不碰 `index.md` / `graph.json` | 产出侧漂移 |
| `data/graph.json` | **无任何活消费方** | 长期不更新 |
| **worktree 任务 agent** | 按项目配置找 `graph_id`，但 worktree 无 `.nezha/config.toml` | **完全读不到**（静默跳过） |

三个滞后点：① hub **只在启动时拉一次、无落后检测**；② `index.md` 不随写入重建（实测落后 4 天）；③ **HIS/ICUCIS 的 adapter 已删除 ⇒ index 永久无法重建**；`EMR` 连 `graph.toml` 都没有。

**关键更正（推翻原 ticket 07 的前提）**：`index.md` 是**「模块目录」**（模块 id / 业务领域 / 工程数 / 卡片链接 + 跨模块依赖），**不含任何知识条目**；而规则层要求目标卡片必须已存在（`knowledge.rs:685`）⇒ **沉淀永远不新建模块 ⇒ append 条目不改变模块集合 ⇒ 影响不到 `index.md`**。「落后 4 天」是历史遗留（由模块在 adapter 之外被创建造成），与沉淀无关。

---

## 2. 目标与非目标

### 目标

1. 知识沉淀**全自动**：任务完成即完成沉淀，不需要人点按钮、不需要人工编辑议题。
2. 以**多层自动质量门**取代人工把关，作为唯一安全网；取向明确为**「宁缺毋滥」**。
3. 保证消费侧**每次读到最新图谱**。

### 非目标（本迭代不做）

- **不做修正/取代语义**：冲突一律拒，旧条目保持 append-only（理由见 §5.3）。
- **不做条目级自动撤回**：只保证条目带标记使将来可做；当前回滚靠 `git revert`。
- **不做周期性图谱 lint / 抽样审计**：本迭代只定指标与口径（§9）。
- **不做存量图谱治理**：历史重复/陈旧内容的清理另起 effort。
- **不修技能安装机制**：不追求「agent 自动触发图谱技能」，改为 agent 无关的注入（§7.2）。
- **不自动降级**：指标超阈告警 + 一键降级，由人拍板（§9.4）。
- **不新增账本**：以图谱内容自身为去重基准（§5.1）。

---

## 3. 方案总览

```
任务会话（主 agent，上下文完整）
   │  收尾时按【产出契约】写候选 JSON（含显式 skipped）
   ▼
<project>/.nezha/drafts/<taskId>/knowledge.json
   │  任务 done → Nezha 自动处理（无按钮）
   ▼
┌─────────────── Nezha 侧四层质量门（任一不过即拒）───────────────┐
│ L0 结构      Rust：字段/置信度/模块名/section 真实性              │
│ L1 依据核验  Rust：evidence 指向的文件必须存在且含所声称符号  ★新增 │
│ L2 去重      Rust：规范化哈希 + 字符 bigram 检索（目标图谱全量）   │
│ L3 语义      LLM：内联卡片，判 duplicate/conflict/distinct        │
│              └ 双跑一致才放行，不一致即拒                        │
└──────────────────────────────────────────────────────────────┘
   │  通过的条目
   ▼
append 到 knowledge-graphs/<id>/data/modules/<module>.md
   （带可追溯标记；一次沉淀 = 一个 commit）→ git commit → pull → push
   │
   ├─ 成功 → 结束（不碰云效）
   └─ 失败 → 建云效议题（唯一的人工入口）+ 显著告警 + 可重试
```

---

## 4. 产出侧：会话内产出契约

> 决策来源：[ticket 01](../../.scratch/knowledge-auto-sedimentation/issues/01-generation-timing-and-owner.md) · [ticket 11](../../.scratch/knowledge-auto-sedimentation/issues/11-sediment-contract-and-scope.md)

### 4.1 形态

**主 agent 在任务收尾时写一份候选 JSON，不拿图谱的写权限。** 图谱写入全部由 Nezha 侧完成（走质量门 + per-graph 写锁 + git 契约）。

- 理由：主 agent 手上有**当场验证过**的上下文（它读过代码），而 post-hoc 提炼只有 8000 字摘要；同时 agent 不需要 SkillHub 仓库写权限，`full_access` 模式下也写不坏共享仓库。

### 4.2 落点与 schema

落点：**`<project>/.nezha/drafts/<taskId>/knowledge.json`** —— 复用既有草稿路径（`agent_assist.rs:1645` 已读该路径），并复用 `drafts.rs:60-98` 的完整路径校验（越界 / 符号链接逃逸 / 大小上限），不新增路径与校验逻辑。

```json
{
  "version": 1,
  "skipped": false,
  "skipReason": "",
  "candidates": [
    {
      "module": "Nto.His.Register",
      "section": "业务规则 / 已知坑",
      "content": "<一句话知识，不写实现细节复述>",
      "evidence": "Nto.His.Register/Nto.His.Register.Bll/Controller/LockNumController.cs:60-61",
      "confidence": "confirmed"
    }
  ]
}
```

**Nezha 只依赖稳定子集**：`module` / `section` / `content` / `evidence` / `confidence`。

- **`knowledgeGraphId` 不再要求 agent 写**——由 Nezha 兜底填入当前绑定图谱 id。理由：现状 `parse_suggestions_json` 会因该字段与绑定图谱不一致而**丢弃整份草稿**（`agent_assist.rs:1650-1658`），而 agent 写错图谱 id 是纯粹的失败源。该段「草稿绑定其他图谱则重新生成」逻辑可随之简化。
- **未知字段忽略**（不因多字段拒收）——为 hub 技能热更新留出前向兼容。

契约文本（schema、规则、`skipped` 表达、优先级、section 清单）**住在 SkillHub 技能里**，随 hub 热更新；Nezha 读技能内容注入任务 prompt。

- **由此产生的硬要求（Nezha 侧承担版本兼容）**：hub 可热更新而 Nezha 是发版制，旧版 Nezha 可能读到不认识的新 schema ⇒ ① 只依赖上列稳定子集；② 未知字段忽略；③ **技能内容缺失/读不到时回退到内嵌规则**（沿用 `KNOWLEDGE_SEDIMENTATION_RULES:509` 的做法），不因 hub 未同步而完全无法沉淀。

### 4.3 确定性：`skipped` 必须显式，「缺失」≠「无新知识」

| 情形 | 判定 |
|---|---|
| 文件存在 + `skipped=true` | 正常结束，**不告警** |
| 文件存在 + 候选非空 | 走四层门 |
| 文件存在但 JSON 坏 / schema 不合法 | **失败**（告警），不静默当 `skipped` |
| **文件缺失** | **告警「未产出沉淀产物」** |

⇒ 「忘了」与「确实没有」机器可分。**不做 post-hoc 兜底提炼**（缺失即告警）。

### 4.4 适用范围：只对绑定图谱的项目强制

- 判据：项目 `.nezha/config.toml` 有 `[knowledge] graph_id`（HIS 项目实测 `graph_id = "HIS"`）。
- 未绑定图谱的项目（如 nezha-main 自身无 `[knowledge]` 段）**既不要求也不提示**——没有可沉淀目标，强求只会逼出无意义的 `skipped`。
- **判定走环境变量注入**（§7.1），因此**即使 worktree 里没有 `.nezha/config.toml` 也能判定**。
- 两个 agent（Claude / Codex）走同一契约，不分叉。

### 4.5 质量门规则从 SKILL.md 移出

`knowledge-graph/SKILL.md` 目前的「回写质量门」六条**删除**（或改为一句「质量卡控由 Nezha 侧执行」的指针）——门已改为 Nezha 侧四层门，agent 不再读 `SKILL.md` 执行卡控。SKILL.md **保留读取契约**：路径约定（技能库根解析、`knowledge-graphs/<id>/data/`）、图谱选择（`graph_id` → `graph.toml`）、读取步骤（`index.md` → `modules/<m>.md`）、section 清单。

**单一归属**，避免两份门规则互相矛盾。

---

## 5. 质量门：四层（核心）

> 决策来源：[ticket 05](../../.scratch/knowledge-auto-sedimentation/issues/05-gate-layers-and-thresholds.md) · [ticket 06](../../.scratch/knowledge-auto-sedimentation/issues/06-cross-task-dedup-ledger.md)

**分界原则**：**确定性的事不交给 LLM，LLM 只做语义。** 任何一层不过 ⇒ 该条拒绝（一票否决）。

### 5.1 L0 — 结构（Rust，扩展现有 `validate_candidate`）

内容/依据非空、`confidence == "confirmed"`、模块名安全（`module_is_safe`）、目标卡片存在、section 在卡片中真实存在（`normalize_section` 归一化后匹配）。

### 5.2 L1 — 依据核验（**Rust 确定性，本规格新增**）

> 实现于 `src-tauri/src/knowledge_gate.rs::EvidenceResolver`。以下为**实现后实测校正过**的最终形态。

**四条判定**：

1. **文件存在性**：解析 `evidence` 中的路径声明（带行号如 `...cs:60-61`），必须在项目内解析到真实文件；
   带行号时校验行号落在文件范围内。反斜杠/正斜杠与大小写不敏感（Windows）；绝对路径与 `..` 一律拒绝。
2. **路径解析放宽为「后缀匹配」**（实测必需）：图谱里的依据常写成项目内的**局部路径**——
   卡片写 `Register.Bll\Controller\LockNumController.cs`，实际位于
   `Nto.His/Nto.His.Register/Nto.His.Register.Bll/Controller/...`。精确根相对匹配会
   把这类**合法**依据误判为不存在，因此允许声称的每一段是实际路径对应段的**后缀**；
   只给单个文件名时不做放宽（否则必然撞上同名文件）。
3. **内容一致性（标识符）**：断言里出现的**代码标识符**（含大写或下划线，长度 ≥4，
   且排除来源标注）必须能在依据文件或依据文本中找到。这是**最强的确定性信号**。
4. **「用户确认」/ 目录 / 工程名 / 提交号**：无法逐文件核验，按可辨识位置放行，
   但保留来源字样以便追溯；带分隔符的目录引用**必须真实存在**（否则视为编造而拒绝）。

**索引构建的两条实测校正**：
- **刻意不套用 `.gitignore`**：HIS 仓库显式忽略了自己的 `Nto.His.Register.Bll` / `IBll`
  （`.gitignore:372-373`），而卡片恰恰引用其中的文件——按 gitignore 剪枝会误杀合法知识。
  改为只按目录名剪掉重型产物目录（`bin` / `obj` / `node_modules` / `target` …）。
- **排除 `.nezha/worktrees/` 子树**：任务 worktree 是同一份代码的分支副本，留着它会让
  「依据存在」变成对旧分支的核验（假通过），并使索引体积翻倍。索引懒构建，仅在需要后缀匹配时才遍历。

**源码读取必须有损解码**：业务仓库的 C# 源码大量是 **GBK** 编码（实测 HIS 的
`RegistrationCardController.cs` 用 `read_to_string` 直接报 `stream did not contain valid UTF-8`，
会把合法依据误判为读取失败）。L1 只比对 ASCII 标识符，故用 `String::from_utf8_lossy` 即可，
无需引入解码依赖。

**为什么必须由 Rust 做**：实测证明 LLM 无法核实依据真伪（内联模式下虚构条目被放行），且同一虚构条目 1/3 漂移。依据核实是「这文件到底存不存在」——确定性问题的答案不应交给概率模型。

**⚠️ 已知残余风险（实测发现，无法由 L1 消除）**：**「引用真实文件 + 纯中文断言 + 不含任何代码标识符」**
这一类虚构无法被 L1 识别。曾尝试用中文二元组覆盖率区分，**实测失败**：
真实断言覆盖 24%~35%、虚构断言 21%，分布重叠，设阈值会把合法知识一并拒掉
（`genuine21` 实测仅 24%）。因此确定性层**不做**该判定，此类污染只能由 L3 语义判定承担；
实测中 `assets/04/` 的 `fabricated_no_such_code`（引用真实 `LockNumController.cs` 却断言
其中不存在的「30 天跨院区重挂」规则）就是被 L3 放行的案例。已写成回归测试
`l1_cannot_catch_pure_prose_fabrication_by_design` 固定该行为，并计入 §9 的抽样审计口径。

### 5.3 L2 — 去重（Rust）

| 子层 | 机制 | 判定 |
|---|---|---|
| **L2a 规范化哈希** | 内容归一化（剥反引号、空白、标点、全半角、日期与来源标注）后哈希相等 | **直接拒**（确定性、零漂移） |
| **L2b 字符 bigram 检索** | 手写 CJK 双字组倒排（约 100 行，**零新依赖**），在目标图谱全量条目上取 top-K | **仅检索**，把可疑候选送 L3；**不单独裁定重复** |

**L2a 是必需的，不是优化**——实测证明现状的逐字匹配被一个反引号击穿（`SchedulId` vs `` `SchedulId` ``），6 条重复候选全部漏过规则层。

**L2b 不单独裁定的理由**：改写后可能几乎不共享 bigram（`异常退出会残留占用` ↔ `进程非正常结束时占用状态不会被清理`），所以它只缩小 L3 的检索窗口。

**比对范围**：**整个目标图谱的全部 `modules/*.md`，不跨图谱。**

- 不依赖 agent 猜对模块——04 证明 agent 写错 section 很常见，module 同样不可信。
- 不跨图谱：四张图谱面向不同系统，同名业务概念往往**应该**各自记录，跨图谱比对误杀风险高于收益。
- 成本：126 张卡片 / 1079 条 / 289 KB，全量读取 + 归一化 + 建索引 **< 20 ms**。

**批内去重：做。** 同一批候选先按 L2a 去重，相同者只保留依据更具体的一条（带文件名+行号者优先），其余拒绝并标注「与本批第 N 条重复」。理由：现状不检查批内重复，同内容会被分别 append 到不同模块，属纯白送的污染路径。

**不做修正/取代语义**：旧条目 append-only，冲突一律拒。理由：门**无法分辨「新知识是对的修正」还是「新知识是错的断言」**；无人审核下区分二者需要引入「谁是真相」的判定，风险大于收益。**真发现写错了 → 走 §8 的回滚通路**（`git revert` / 撤回条目），而不是靠新条目覆盖旧条目。附带好处：append-only 语义单纯，配合「一次沉淀 = 一个 commit」使回滚边界清晰。

### 5.4 L3 — 语义判定（LLM，内联卡片）

- **内联卡片进 prompt，不让它探索仓库**：实测 5–20 s vs 80–436 s，**语义判定质量不变**（同样的拒绝集合、仍能放行真知识）。
- prompt 内联 top-K（K≈5）个检索到的既有条目，放在 `<EXISTING>` 块里并**声明为数据**（防卡片内容注入 prompt）。
- 输出：`<GATE>[{"index":N,"verdict":"duplicate|conflict|distinct","match":"...","confidence":"...","reason":"..."}]</GATE>`
- **双跑一致才放行**：跑两次独立调用（第二次换候选顺序），逐条一致才放行；**任一次报出 duplicate / conflict 即拒**。不一致即拒绝并记录两次理由。
  - 理由：实测 1/3 漂移。在「直写主干、无人把关」下，一次漏放就是永久污染。
  - 成本：每批 2 次内联调用，实测单次 5–20 s ⇒ 总耗约 10–40 s。
- **`conflict` 直接拒绝，不写入**，不设人工队列（用户已定「无人把关」）。冲突条目的归宿是拒绝 + 失败议题/告警（§8）。
- **失败语义（fail-closed）**：`<GATE>` 解析失败、缺判定、判定重复/多余 —— 一律按未通过。现状方向正确，保留。

### 5.5 超时与降级语义（**必须修**）

- 超时线按内联实测重设（内联 5–20 s，双跑仍宽裕，保守设 **120 s/次**）。
- **超时、进程失败、输出不可解析一律「逐条降级为未通过」**，不再 `?` 上抛导致整批静默丢弃（现状 `knowledge.rs:859-869`）。
- 顺带修 `agent_assist.rs:276` 那句从别处复制的错误超时文案（质量门路径下显示「生成任务名称超时」）。
- 成本上限：单次沉淀 ≤ 2 次 headless 调用、合计 ≤ 60 s（不含 git）；超出即拒绝并报「质量门超时」。不做排队降级（保持简单可预测）。

### 5.6 随本规格一并修的既有缺陷

- gate prompt 的卡片路径 `{target_id}/data/modules/...` 写错（`knowledge.rs:755`）——不致命但会误导模型；改为真实路径或改为内联。
- `allow_read_tools=false` 对 codex **无效**（该参数只在 claude 分支生效，`agent_assist.rs:66-77`）——改用内联后此问题消失，但契约要写清。
- 每候选一次 `git status`（`module_card_has_uncommitted_changes`）⇒ 改为**整批一次**。

### 5.7 阈值取向（不可反）

**宁可漏写 30%，也不放行 1 条冲突。** 任何不确定（判定漂移、依据无法核验、section 存疑）一律倒向拒绝。

---

## 6. 写入与 git 契约

> 决策来源：[ticket 07](../../.scratch/knowledge-auto-sedimentation/issues/07-index-graphjson-rebuild-and-push.md)

### 6.1 写入块格式（含可追溯标记）

```
- 2026-09-16 · 已确认 · <content>
  - 依据：<evidence>
  <!-- kg:task=<taskId> session=<sessionId> gate=L0,L1,L2,L3 -->
```

- **保留现有主体**（日期 / 已确认 / 内容 / 依据），标记以**不打扰阅读**的方式附加。
- **零迁移成本**：§1.2 已证从未写入过任何条目，格式改动**不需要任何迁移逻辑**。

### 6.2 `index.md` / `graph.json`：写入路径不重建

- **`index.md` 不受沉淀影响**（§1.3）：沉淀永不新建模块 ⇒ append 条目不改变模块集合 ⇒ **写入路径无需重建 index**。
- **`graph.json` 停建**：无任何活消费方。
- 已知遗留（记入基线，非本规格引入）：`index.md` 漂移 101 vs 100；HIS/ICUCIS adapter 缺失 ⇒ index 无法重建；EMR 无 `graph.toml`。

### 6.3 commit / push

- 写入通过的条目后：`git add` → `git commit` → `git pull --ff-only` → `git push`。
- **一次沉淀 = 一个 commit**（回滚边界清晰）。提交信息沿用 `docs(knowledge): auto sediment {n} entries via Nezha`。
- **upstream 是 `master`**（实测 `## master...origin/master`）；`git push` 现状不带 remote/branch（假定 upstream 存在）——保留该假定，但规格里显式写明远端与分支。
- **写前拉取**：若检测到落后，先 `--ff-only` pull，降低非快进冲突概率。若 pull 因本地未提交改动 / 已分叉失败 ⇒ **拒绝写入并明确报错**（不在分叉状态下硬写）。
- **并发**：Nezha 自身写入已由 per-graph 写锁（`lock_graph`）串行化；跨机器/跨人同时回写会产生非快进 push 失败 ⇒ 保留本地提交 + 返回可重试错误 + 失败议题。

### 6.4 重试语义（**修一个真实漏洞**）

**漏洞**：`push` 失败后重跑时，卡片里已有那些条目 ⇒ 会被去重层判为「重复」⇒ 得出「无新内容」⇒ **永远不 push**。

**正确顺序**：重试时① 先检查本地是否有**未推送的提交**（比对 upstream），有则**先补推**；② 再重跑门处理新候选。

**不依赖「上次写了什么」的状态标记**，只依赖**图谱实际内容 + git 状态**——与「不引入账本」的取向一致。

### 6.5 幂等

- 天然幂等：重复处理同一 `knowledge.json` 时，已在图里的条目会被 L0/L2/L3 判为重复而拒绝 ⇒ 不会重复写入。
- **不新增**「已沉淀」布尔标记到 Task；`Task.knowledgeIssueIds` **保留字段但从幂等语义退役**（保留而非删除，避免破坏用户已存数据结构）。可选新增**只读展示字段**（最近沉淀时间/写入条数/拒绝条数），**不作为幂等依据**。

---

## 7. 可达性与新鲜度

> 决策来源：[ticket 10](../../.scratch/knowledge-auto-sedimentation/issues/10-graph-reachability-in-sessions.md) · [ticket 07](../../.scratch/knowledge-auto-sedimentation/issues/07-index-graphjson-rebuild-and-push.md)

### 7.1 图谱可达性：agent 无关的环境变量注入

- 在 `setup_nezha_env`（`pty.rs:361`，已注入 `NEZHA_TASK_ID` / `NEZHA_AGENT` / `NEZHA_EVENT_DIR`）新增 **`NEZHA_KNOWLEDGE_GRAPH_ID`** + 解析后的图谱数据目录。与 `skills.rs:1705-1706`（`NEZHA_PROJECT_ROOT` / `NEZHA_SKILL_DATA_DIR`）的既有惯例一致。
- **图谱身份由 Nezha 从项目配置（`knowledge.graph_id`）解析后下发**，因此 worktree 里（无 `.nezha/config.toml`，实测确认）也能拿到。
- 未绑定图谱的项目不注入，agent 行为与现在一致。
- 注入用途是**让 agent 干活时能参考图谱**（非为沉淀服务）——去重是 Nezha 侧职责，所以本项**不是**产出契约的硬前置。

### 7.2 不修技能安装

- 查证：**所有** hub 技能都只装在 Codex 侧（`~/.codex/skills/*`），Claude 侧一个都没有；且当前 `claude_enabled: false`。这是安装选择，不是 bug。
- 决定：图谱读取**不再依赖「技能被装到某 agent 的技能根」**——环境变量注入对 Claude / Codex / 未来 agent 一律成立。
- 已知限制：agent 少了「技能自动触发」这一层，只能靠 prompt 指引或自身判断去读图谱。若将来要真正自动触发，需另开 ticket 修安装/同步机制。

### 7.3 hub 新鲜度：每 15 分钟后台拉取

- **每 15 分钟后台 `fetch` + `--ff-only pull`**，自动、无需手动点；有更新则提示。
- **性能实测（回应担忧）**：hub `.git` 仅 **2.6 MB**，一次 `fetch` **2.26 s**；当前落后 1 个提交 ⇒ 15 分钟周期开销可忽略。
- 复用既有实现：`skills.rs` 的 fetch + `--ff-only` pull（`sync_skill_source_persist`，含「强制 `--no-rebase` 防止 `pull.rebase=true` 劫持」的处理，`skills.rs:851-869`）；新增 interval task 调同一函数（注册在 `lib.rs` setup）。
- **必需护栏**：① 全程异步，绝不阻塞 UI 主线程；② 设超时（如 30 s），超时/断网**静默沿用缓存**；③ **沉淀写入持有 per-graph 写锁期间跳过本次拉取**；④ 连续失败**退避**（如降为 30/60 分钟）；⑤ 复用既有 `skill-hub-changed` 事件（`skills.rs:1082`）驱动前端刷新与提示。
- **shallow → 完整 clone**：当前 `--depth 1` shallow（`.git/shallow` 存在）。仓库仅 2.6 MB，代价可忽略；而浅历史会让 `git revert` **意外失败**（§8 依赖它）。

---

## 8. 失败、回滚与可追溯；云效议题；前端形态

> 决策来源：[ticket 08](../../.scratch/knowledge-auto-sedimentation/issues/08-failure-rollback-and-yunxiao-fate.md)

### 8.1 触发：任务完成即自动处理，无手动按钮

- 任务 `done` → Nezha 自动读 `knowledge.json` → 四层门 → 写入 + commit + push。**不需要点任何按钮。**
- **前端退役**：RunningView 的「知识沉淀」按钮（`RunningView.tsx:576-598`）、`KnowledgeSedimentationDialog` 预览弹窗（逐条勾选/编辑/「创建 N 条」）、`handleGenerateKnowledgeSedimentation` 的草稿复用分支、`App.tsx:2845` 的「合并成一条议题」逻辑。
- **前端保留**：一个**只读的「本次沉淀结果」入口**（写了哪些、拒了哪些及理由）+ 失败时的告警与重试。
- 与范围盘问时未选「触发自动化」不冲突：那项指「done 后额外跑一次独立 post-hoc 提炼」；本项处理的是会话内**已产出**的 `knowledge.json`，生产者不同。

### 8.2 云效议题只在失败时建

- **成功路径完全不碰云效**（链路纯自动）。
- 失败时才建议题：质量门拒绝且值得人看、依据核验失败、push 失败、仓库分叉、本地有未提交人工修改。
- 复用现有能力：`yunxiao_create_knowledge_issue`（`yunxiao.rs:1811`，标题去重）+ `yunxiao_create_workitem_comment`（`yunxiao.rs:1159`，贴明细）。
- **顺带消灭现状两个病灶**：① 「议题去重命中 ⇒ 整体跳过回写」（`App.tsx:2903`）——重试永远不发生的根因，议题退出主链路后自然消失；② `knowledgeIssueIds` 作为幂等标记的语义不再成立（§6.5）。
- 议题正文必须写清：哪个任务、哪个图谱/模块、失败在哪一层、门给的理由、重试入口。

### 8.3 可追溯与回滚

- **条目级标记 + 一次沉淀一个 commit**（§6.1 / §6.3）。
- 获得：可定位「这条是谁、哪个任务、哪次会话、哪个模型判的写」；可区分**自动写入**与人工写入的条目；配合一沉淀一 commit 既能整批 `git revert`，也为**条目级撤回**留出可能（**条目级自动撤回机制不在本迭代**，本迭代只保证标记存在使将来可做）。
- 回滚通路：`git revert <commit>`。**完整 clone 是前提**（§7.3）。
- **「知识需要修正」的实际出路**：发现写错了 → 回滚该 commit / 撤回条目（因为 §5.3 定了冲突一律拒、不做取代语义）。

### 8.4 开关：移除 `autoWriteback`，保留一个总开关

- **移除 `autoWriteback`**：`app_settings.rs` 的 `KnowledgeSettings` 字段、`save_knowledge_auto_writeback` 命令、`SkillsPanel.tsx:320-341` 的开关 UI——自动是唯一行为，半成品语义（"自动回写"）不该留给用户。
- **新增/改名「知识沉淀总开关」（默认开）**：关掉则完全不跑沉淀，**且该项目的 agent 不再被要求产出 `knowledge.json`**（契约范围随之豁免，避免逼出无意义 `skipped`）。
- 这是用户可见的前端改动 ⇒ **PR 必须附截图**（暗色 + 亮色；开关的开/关两态）。

### 8.5 失败可见性

每次沉淀的结果（通过/拒绝/写入条数/失败原因）必须**逐条**可见，不再像现状那样只弹一个 toast、失败整批上抛。由「只读沉淀结果」入口（§8.1）+ 失败议题（§8.2）共同承担。

---

## 9. 度量与验收

> 决策来源：[ticket 09](../../.scratch/knowledge-auto-sedimentation/issues/09-pollution-metrics.md)

### 9.1 污染定义（可判口径）

| 类别 | 口径 | 检出 |
|---|---|---|
| 重复 | 与任一既有条目规范化后相同，或 L3 判 duplicate | 自动 |
| 冲突 | L3 判 conflict | 自动 |
| 无依据 | L1 依据核验失败 | 自动 |
| 实现细节当业务规则 | 内容是代码复述而非规则/坑 | 抽样人工 |
| 过时条目 | 引用的代码位置已变更/删除 | 事后 lint（本迭代不做） |
| 空洞表述 | 口号/待办/无关 | L0 + L3 |

### 9.2 自动指标（数据源：§8 的只读结果 + 失败议题）

1. 写入条数（每次/累计）
2. 拒绝条数 + 理由分布（按层，L3 再分 duplicate/conflict/其他）
3. `skipped` 率与理由分布（**漏写侧**）
4. **产物缺失次数**（契约失效的直接信号）
5. **人工回滚次数 / 比率**（`git log --grep` 关联 revert 与 auto sediment）—— **误放行的最硬信号**

### 9.3 抽样指标（人工、低频）

6. **错判率**：从近 N 条已写入条目抽样（如 20 条）人工判是否属 §9.1 六类之一。**唯一能发现「实现细节当规则」与「过时」的手段。**

### 9.4 越界处置：超阈告警 + 一键降级（人工拍板），**不自动降级**

- 触发后**显著告警**（非普通 toast），设置里提供**一键降级**：关总开关或切到「只建议题不写入」。
- **为什么不自动降级**：指标样本小、口径会演进 ⇒ 阈值有噪声，自动降级会反复抖动并产生「今天为什么没写」的不可解释状态；降级改变系统行为边界，应由人拍板并留痕。
- 阈值建议（实现可调，取向不可反）：① 7 天窗口内**人工回滚 ≥ 2 次**；② 抽样**错判率 > 10%**；③ **产物缺失率 > 20%**；④ L3 因「双跑不一致」拒绝占比 **> 30%**（说明判定不稳、门形同虚设）。

### 9.5 验收：直接复用 `assets/04/` 夹具做新旧对照

**夹具**：6 条候选（4 真重复 + 1 虚构依据 + 1 冲突）、4 条虚构探测、2 条真·新知识；含生产 prompt 与全部运行输出。

**新链路必须满足**：

| 要求 | 依据 |
|---|---|
| 4 条重复**全拒**（反引号 / 空白 / 措辞改写三种） | 旧链路 0/4 放行 |
| 1 条冲突**全拒** | 旧链路靠 LLM 运气 |
| 4 条虚构依据**全拒**（L1 依据不存在 3 条 + L3 语义 1 条） | 旧链路 1/3 漂移被放行 |
| 2 条真知识中，依据成立且 section 正确者**必须写入** | 防「全拒」退化成无用门 |
| **总耗时在超时线内** | 旧链路 436 s 撞 180 s 超时 |

> **实测校正（实现后）**：原始口径要求「4 条虚构依据**全部由 L1 确定性拒绝**」，
> 实现后实测不可达 —— 其中 `fabricated_no_such_code` 引用的 `LockNumController.cs`
> **真实存在**，且断言为纯中文、不含代码标识符，L1 与 L3 均放行（详见 §5.2 残余风险
> 与 §12）。可被确定性层拦下的是「依据路径不存在 / 标识符在依据中找不到」那类。
> 该条已改写为「全拒」，并明确分工：3 条由 L1 拦下、1 条交由 L3 承担。

> **验收回归已入库**（不再是临时脚本）：`src-tauri/src/knowledge_gate.rs::acceptance::acceptance_deterministic_layers`
> 与 `src-tauri/src/knowledge.rs::acceptance_l3::acceptance_l3_dual_run`，均标 `#[ignore]`
> （依赖本机 HIS 检出与真实 CLI 调用，不进 CI）。跑法：
> `cargo test --lib acceptance -- --ignored --nocapture`；夹具已入库于
> `src-tauri/tests/fixtures/knowledge-gate/`（可用 `NEZHA_KG_E2E_ROOT` 覆盖），
> 另需 `NEZHA_KG_E2E_PROJECT`（业务项目根）与 `NEZHA_KG_E2E_CARD`（被比对模块卡片）。

**端到端**：真实 HIS 任务 → 产出 `knowledge.json` → 自动跑门 → 写入 + commit + push → 图谱内容确实新增 → **重跑同一产物不产生重复条目**（幂等）。

---

## 10. 影响面

### Nezha（`src-tauri/`）

| 文件 | 改动 |
|---|---|
| `knowledge.rs` | 四层门重构（增量 L1 依据核验、L2 规范化哈希 + bigram、L3 改内联 + 双跑）、超时与逐条降级、写入块加标记、整批一次 `git status`、写前 pull、重试补推、`graph.json` 停建 |
| `agent_assist.rs` | `generate_knowledge_sedimentation` 与 `SEDIMENTATION_*` 退役/改造为「读契约产出」；超时文案修正 |
| `app_settings.rs` | `KnowledgeSettings`：移除 `autoWriteback`，加总开关；同步 `save_knowledge_auto_writeback` |
| `pty.rs` | `setup_nezha_env` 注入 `NEZHA_KNOWLEDGE_GRAPH_ID` + 数据目录 |
| `skills.rs` / `lib.rs` | 15 分钟后台 fetch+pull 的 interval task；shallow → 完整 clone |
| `storage.rs` | Task 只读展示字段（如需要）与 `types.ts` 同步 |
| `knowledge.rs` / `lib.rs` | 命令注册调整（总开关等） |

### Nezha（`src/`）

| 文件 | 改动 |
|---|---|
| `App.tsx` | 移除沉淀按钮链路与议题合并逻辑；接自动处理；只读结果入口；失败告警/重试 |
| `components/yunxiao/KnowledgeSedimentationDialog.tsx` | 退役（或改为只读结果视图） |
| `components/RunningView.tsx` | 移除「知识沉淀」按钮 |
| `components/app-settings/SkillsPanel.tsx` | 移除 `autoWriteback` 开关，加总开关 |
| `types.ts` | `KnowledgeSuggestion` 调整（去 `knowledgeGraphId` 要求）、只读结果类型、Task 字段 |
| `i18n.tsx` / `styles/` | 文案与样式（无 inline style） |

### SkillHub

| 内容 | 改动 |
|---|---|
| 技能（沉淀契约） | 新增/改造：写入侧契约（schema、`skipped`、优先级、section 清单），随 hub 热更新 |
| `knowledge-graph/SKILL.md` | **删除**「回写质量门」六条（改由 Nezha 定），保留读取契约 |
| （可选）adapter | 恢复 HIS/ICUCIS adapter 使 index 可重建——**本迭代仅记为已知限制**，除非实现时发现必须 |

### 不触及

- **终端性能红线**（不新增事件广播；hub 拉取走既有 `skill-hub-changed`）。
- **存量图谱数据**（不做历史清理）。
- 图谱骨架构建/扫描机制。

---

## 11. 实施顺序建议（供 PR 拆分）

按「先立安全网、再开自动」的顺序，每步可独立验证：

1. **质量门重构**（L0 + **L1 依据核验** + L2 去重 + L3 内联双跑 + 超时降级）——纯后端，用 `assets/04/` 夹具回归。**这一步完成前不要开启自动写入。**
2. **写入块标记 + 一沉淀一 commit + 重试补推 + 写前 pull**——后端。
3. **hub 15 分钟拉取 + 完整 clone + 环境变量注入**（可达性与新鲜度）。
4. **产出契约**（会话内产出 `knowledge.json`、`skipped` 语义、适用判定）+ `KNOWLEDGE_GRAPH_ID` 注入生效。
5. **自动触发 + 前端退役/改版 + 开关调整**（含截图）。
6. **失败议题 + 只读结果入口 + 指标埋点**。

其中 1 与 3 互相独立，可并行。按 nezha 的 AGENTS.md，开工前需在 `Alohazzz/nezha` 开提案 issue 并取得 maintainer 确认。

---

## 11.5 实现后校正（code-review 修复项）

实施第 1 步（质量门重构）后经独立 code review，修掉以下问题；其中前三条是**本轮实现引入的真实缺陷**，记录在此以免后续回退：

1. **`append_entry` 的 `expect` 崩溃**：section 在 L0 校验、到写入之间隔着 L1~L3（可达数分钟、两次模型调用），期间卡片可能被 hub 拉取或人工编辑改动 ⇒ 改为**重新定位 + 优雅失败**（返回「模块卡片已在判定期间变更，请重试」），不再 panic 在 async 命令里。
2. **换行注入卡片结构**：候选 `content` / `evidence` 含换行会伪造出 `## ` 标题，使后续条目被挂到假 section 下 ⇒ 写入前拒绝含换行的候选。已配回归测试。
3. **`core.quotepath` 转义导致脏卡漏检**：`git status --porcelain` 默认对非 ASCII 路径做 C 转义，解析出的模块名是垃圾 ⇒ 脏卡判定落空 ⇒ **卡片被静默覆盖**（正是本层要防的事）。改为显式传 `-c core.quotepath=false`。
4. **脏卡检测失败不再整批报错**：`git status` 失败时按「全部未提交」逐条降级（与注释一致），而不是丢掉已经付出的模型判定。
5. **纯数字不再当代码标识符**：`2026` / `1471` 这类正文数字会造成纯粹误杀。
6. **同一依据文件只读一次**（原先带行号时读两遍），读失败如实报错而非降级成「符号找不到」的误导信息。
7. **`.nezha` 在遍历时剪枝**（原先只做后置过滤，仍会整棵遍历 worktree 副本）。
8. **内联既有条目单项截断 400 字**，给 Windows argv 上限留余量（否则单个超长条目会让**每个**分块都在命令行层面失败）。
9. **归一化后为空的候选拒绝**（纯标点内容原先会绕过 L2 直接写入）。
10. **「用户确认」不再被附带代码位置否决**：依据形如「用户确认：…（原逻辑在 X.cs）」时，不再因为那个附带位置找不到而否定用户确认本身。
11. **写入成功时保留 L1 依据核验结论**（`已自动写入模块卡片（依据文件已核验：…）`），兑现「即便通过也保留以便追溯」。
12. **提示词补「index 原样回填、每条只输出一条」**（缺此约束时模型重新编号会让整块候选 fail-closed）。
13. 修掉 `agent_assist.rs` 里从别处复制的超时文案（`生成任务名称超时` → `agent 调用超时`）。

**仍待后续处理的已知取舍**（未在本轮修，理由记录于此）：
- **单次沉淀的调用上限**：提案 §5.5 说「≤2 次 headless 调用、合计 ≤60 s」，但分批后实际是 `2 × 分块数` 次、每次上限 120 s。极端情况（候选多 + 上下文大）可能远超预算。**需要在实现第 6 步（指标埋点）时补 wall-clock 预算**，本轮先记录。
- **L0 与写入循环内的同步文件 I/O 未包 `spawn_blocking`**：与 AGENTS.md 的约束有出入。当前实现在毫秒级（单卡片读取），但严格合规应在后续收敛。
- **后缀匹配的宽松度**：`actual.ends_with(claimed)` 比「同段」宽松，边界是可能命中语义无关的同名文件；实测 HIS 无歧义。

## 11.52 实施进度：第 5 步后端（自动触发 + 总开关）已完成

| 项 | 实现 |
|---|---|
| 自动触发 | `pty.rs::finalize_task_exit` 在 `gather_task_drafts` **之后**调 `knowledge::spawn_auto_sedimentation`（必须在 gather 之后，否则 worktree 里写的 `knowledge.json` 还没收拢到项目根） |
| 立即返回 | 实际工作在 `tauri::async_runtime::spawn` 里跑（一次沉淀含最多两次模型调用），结果经 `knowledge-sedimentation` 事件上报，**不拖住 PTY 退出收尾** |
| 三个前置条件 | 总开关开启 ∧ 项目绑定图谱 ∧ 产物存在；未绑定图谱**直接跳过并返回正常**（产出契约本就没注入，不是错误） |
| agent 来源 | 用**该任务自身的 agent**（不是「默认 agent」——任务可能用非默认的那个），由 `finalize_task_exit` 传入 |
| 总开关 | `KnowledgeSettings.auto_writeback` → `enabled`，语义改为「知识沉淀总开关」、**默认由关改为开** |
| 旧值迁移 | `autoWriteback` / `auto_writeback` 作为 `#[serde(alias)]` 继续可读，**旧 settings.json 无需手工迁移**；显式 `false` 被尊重 |
| 命令名 | 总开关写入命令由 `save_knowledge_auto_writeback` 改为 `save_knowledge_enabled`；**旧命令名保留为等价别名**，故前端无需同时改动即可生效 |

**为什么把 `agent` 一路传进来**：先写成了读 `settings.agent.default_agent_or_codex()`，但
`AppSettings` 根本没有该字段（编译期发现），且语义也不对——沉淀该用**跑这个任务的** agent。

## 11.53 实施进度：第 4 步（会话内产出契约）已完成（后端部分）

| 项 | 实现 |
|---|---|
| 产出契约文本 | `agent_assist.rs::SESSION_SEDIMENTATION_CONTRACT`（`{TASK_ID}` 占位符，注入时替换） |
| 契约注入范围 | `pty.rs`：仅当项目**绑定了图谱**（`config.knowledge.graph_id` 非空）时追加到任务提示词 |
| 落点 | `.nezha/drafts/<taskId>/knowledge.json`（复用既有草稿路径与校验） |
| `skipped` 语义 | 新增 `SedimentationDraft`（`Skipped{reason}` / `Candidates`）与 `parse_knowledge_draft` |
| 「缺失 = 漏了」 | 草稿文件缺失时**明确报错**（原先是静默回退 headless），不再把漏产出当正常 |
| `knowledgeGraphId` 兜底 | 缺失时由 Nezha 填当前绑定图谱；**显式写了别的图谱**才报错 |
| 前向兼容 | 兼容带壳 `{candidates:[…]}` / 裸数组 / 未知字段忽略（hub 技能热更新的前提） |
| section 收窄 | 规则文本已去掉 `定位` 与 `验证记录`（上一节），并新增断言钉住 |

**当前处于「契约已生效、生产者尚未迁移」的中间态，这是刻意的**：agent 现在会被要求写
`knowledge.json`，但 `generate_knowledge_sedimentation` 已不再回退 headless ⇒ 若 agent
没写，「知识沉淀」按钮会**如实报错**「本次任务未产出知识沉淀产物」。选择这个顺序是因为
「缺失 = 漏了」正是本设计要建立的语义；若保留静默兜底，漏产出将永远不可见。
前端已有 `catch`（`ProjectPage.tsx::openKnowledgeSedimentation` → 弹窗 `error`），
不会崩，只是提示。**第 5 步退役该按钮与预览弹窗后，此中间态即消失。**

**顺带修正一处断言陷阱**：`定位` 是常用词（规则里「可**定位**的依据」本身含它），
全文子串断言会误伤 ⇒ 改为只在「section 限定」那一行上断言清单内容。

## 11.54 实施进度：第 2 步（写入契约与重试）已完成

| 项 | 实现 |
|---|---|
| 条目可追溯标记 | 写入块追加 `<!-- kg:<图谱>@<UTC>.<随机段> -->`，与提交信息里的 `kg=<token>` 对应，可 `git log -S` 互查 |
| 一次沉淀一个 commit | 原实现即满足（有写入才提交，一次命令一个 commit），已确认 |
| **重试先补推** | 新增 `push_pending_commits`：写前 `fetch` → 落后则 `--ff-only` pull → 补推未推送提交 |
| 写前 pull | 同上；**分叉时明确拒绝写入**（不 merge、不 rebase、不硬写） |
| 结果可见性 | `KnowledgeWritebackResult` 新增 `pushedPending`（前端 `types.ts` 同步） |

**修掉的真实漏洞**：`push` 失败后重跑时，卡片里已有那些条目 ⇒ 会被去重层判为重复 ⇒
本次没有新写入 ⇒ 若只依赖「有写入才提交」，那些本地提交会**永远推不上去**。现在每轮先补推。

**实现中发现并修掉的两个问题**：

1. **`@{u}` 是本地引用，不 fetch 就发现不了远端前进**。我最初只比对 `HEAD..@{u}` 判断落后，
   实测在一个「上游已被他人推进」的仓库里得到的仍是 `behind=0`（因为本地跟踪引用没更新），
   于是补推会以非快进失败告终、且被误判成「仓库有问题」。改为先 `fetch origin`（实测约 2 s，
   失败不阻断，后续 pull/push 会照实报错）。
2. **token 撞车**：毫秒级时间戳在同一毫秒内连续调用会生成相同 token（实测两次调用相同），
   而 token 的用途正是区分不同批次、供按批回滚 ⇒ 加 8 位随机段。

**真实 git 仓库上的不变量验证**（`acceptance_push_pending_commits`，`#[ignore]`）：
按仓库实际状态断言两种之一——**仅领先**时补推成功且补推后无未推送提交；**已分叉**时
必须拒绝，且**不得**留下 `.git/MERGE_HEAD` / `rebase-merge` / `rebase-apply` 半成品状态，
本地提交必须保留。两种夹具都实测跑通：分叉场景输出「图谱仓库落后远端且无法快进……已停止
写入以避免损坏仓库」，并确认仓库未被改动（ahead=1 / behind=1、无 merge 中间态）。

## 11.55 实施进度：第 3 步（hub 定时拉取 + 图谱可达性注入）已完成

按 §11 的实施顺序，第 3 步（可达性与新鲜度）已落地——新鲜度见上表，可达性见本节末「图谱环境变量注入」：

| 项 | 实现 |
|---|---|
| 每 15 分钟后台拉取 | `skills.rs::periodic_sync_loop`，在 `lib.rs` setup 注册；复用既有 `sync_skill_source_persist`（fetch + `--no-rebase --ff-only` pull） |
| 护栏 1 不阻塞 UI | 走 `tauri::async_runtime::spawn` + 既有 `run_process_with_env`（git 子进程有 120 s kill-safe 超时） |
| 护栏 2 失败静默沿用缓存 | 只写 `lastSyncError` + `eprintln`，不弹错、不打断 |
| 护栏 3 写入期间跳过 | 新增 `knowledge::knowledge_write_in_progress()`（原子计数），沉淀写图谱/提交推送期间跳过本轮 |
| 护栏 4 失败退避 | `next_sync_backoff` 翻倍递增，上限 1 小时，成功即复位 |
| 护栏 5 仅真实变化才通知 | 比对 `last_synced_commit` 变化才 `emit("skill-hub-changed")` |
| 单轮兜底超时 | `HUB_SYNC_ROUND_TIMEOUT` = **10 min**（必须显著大于内层 git 超时之和，否则外层先杀掉正在跑的 git，可能留下 `.git/index.lock` 残骸影响后续提交） |
| 完整 clone | `clone_args` **不再带 `--depth`** |
| **存量浅克隆补救** | 新增 `is_shallow_clone` 检测 + `git fetch --unshallow`（每进程只尝试一次，失败不阻断同步） |

**实测数字（替换此前引用的「2.6 MB」——那是浅克隆的体积）**：本机 hub 补全为完整历史
耗时 **2.06 s、体积无增长**（`.git` 仍 2.6 MB，可达 commit 仍 79）。说明该仓库的
`.git/shallow` 标记早已失效（历史其实已在本地），补全几乎无代价；但**标记存在仍会让
`git revert` 复核历史**，所以保留补救逻辑。

**已知遗留（并入第 6 步）**：`KnowledgePanel` **不监听** `skill-hub-changed`（只有 `SkillHubView` 监听），
因此「读到最新」对 agent 经磁盘生效、但打开着的知识面板不会自动刷新。按决定**并入第 6 步**一起做。

**code-review 修复项**（本轮，均由独立审查发现）：

1. **TOCTOU → 真互斥**：原实现只用一个原子计数「观测」写入是否进行中，而读取与真正执行
   之间有数秒窗口（`fetch`/`pull` 要跑几秒），写入可能恰好插入——图谱数据就在 hub 检出里，
   两者操作的是**同一个仓库**。改为 `skills::lock_hub_git()` 真锁：同步方持锁跑完整轮、
   写入方围绕自己的 git 窗口持锁，二者不构成环（同步方不取图谱写锁）故无死锁。
2. **单卡点覆盖全部同步入口**：锁取在 `sync_git_repo` 里，于是 `startup_sync`（启动）、
   `sync_skill_source`（手动）、`set_skill_hub_path`（改配置）、`periodic_sync_loop`（定时）
   四个路径自动都被覆盖，而不是只有定时那一条。
3. **失败恢复也要通知前端**：原先只在 commit 变化时 emit，导致「离线失败 → 恢复成功但无变更」
   时 `lastSyncError` 已被清而前端不刷新，面板会一直显示已经恢复的旧错误。
4. **退避用 `saturating_mul`**：原先 `current * 2` 在极端输入下会 panic，与本函数「全函数」的
   意图不符。
5. **`publish_knowledge_changes` 先校验参数再取锁**：原先空参数调用也会排队等一次分钟级写入。
6. **测试加固**：`graph_write_guard_tracks_in_progress` 原先只断言「最终归零」，**钉不住**
   「计数必须在拿到锁之后才 +1」这条性质（把 `fetch_add` 提到 lock 之前，原断言依然全过）。
   改为断言精确值（排队者不得计入），并**用变异测试验证过**：注入该 bug 后断言失败（`left: 2`）。
   另新增测试专用访问器 `graph_write_active_count()`（`#[cfg(test)]`）。
7. **用户文档同步**：`docs/operation-manual.md` / `.html` 里「首次自动 `git clone --depth 1`」
   已改为完整 clone，并补「启动后每 15 分钟后台自动拉取」，已跑 `pnpm help:sync`。

**同批完成的另一半：图谱环境变量注入（ticket 10）**

`pty.rs::setup_nezha_env` 现在额外注入 `NEZHA_KNOWLEDGE_GRAPH_ID` 与
`NEZHA_KNOWLEDGE_GRAPH_DIR`：

- **用主项目路径解析**（`real_project_path` 参数），因此 worktree 里
  （`.nezha/config.toml` 被 gitignore、那里没有该文件）agent 也能拿到图谱位置。
- 三处 spawn 路径全部覆盖：`run_task` / `resume_task` / `fork_task`
  （`fork_task` 前端本就传主项目路径，直接复用）。
- **best-effort**：未绑定图谱（`graph_id` 为空）或读配置失败时**不注入**，
  agent 行为与原来一致，绝不影响任务启动。
- 解析成本：只读两个小配置文件 + 路径拼接，**不扫描图谱目录**，故可直接在 spawn 路径调用。
- 测试：未绑定项目返回空、绑定项目返回 `<hub>/knowledge-graphs/<id>/data`；
  另有一条 `#[ignore]` 的真实仓库集成检查（断言注入的目录真实存在，否则 agent 拿到死路径）。

**踩到的坑（已记入测试注释）**：`ProjectConfig` 的 `agent` / `git` 段是**必填**，而
`read_project_config` 在 `toml::from_str` 失败时会**静默回退到 `Default`**（知识图谱绑定
一起丢失）。我的首个测试夹具只写了 `[knowledge]`，于是测到的是「解析失败」而非
「未绑定图谱」——夹具必须写成完整段。这也是一个真实的既有行为陷阱：
**配置写得不全时图谱绑定会被静默清空**。

**实测验证（启动即验证，不止编译）**：按项目既有流程启动桌面应用，确认 ① 应用正常渲染
（WebView2 CDP：`#root` 有子节点、正文 1817 字符）② 启动同步成功
（`lastSyncedAt` 已刷新、`lastSyncedCommit = ff940cd`、`lastSyncError = None`）
③ 日志无同步报错——确认新增的定时任务没有破坏启动路径。

**为什么补了「存量浅克隆补救」**：只改 clone 参数仅对新装生效，而本机 hub **已经是**浅克隆
（`.git/shallow` 存在）⇒ `git revert` 仍会因历史不足失败，**承诺的回滚能力在这台机器上并不成立**。
故在既有仓库同步分支补 `--unshallow`，让承诺对存量安装也成立。

**顺带修正**：`lock_graph` 的返回值由 `OwnedMutexGuard<()>` 改为 `GraphWriteGuard`（Drop 时递减
原子计数），两个调用点语义不变；计数在**拿到锁之后**才递增，避免排队者被误判为「正在写入」
而使 hub 同步空转等待。

**测试**：`clone_is_full_not_shallow`、`clone_args_includes_branch_only_when_set`、
`sync_backoff_doubles_then_caps`、`sync_interval_is_fifteen_minutes`、
`detects_shallow_clone_by_git_shallow_file`、`graph_write_guard_tracks_in_progress`
（后者合并了两个观测同一全局计数的用例，避免并行抖动）。

## 11.6 内容组织口径（规则文本修订）

**问题**：知识组织规则散落三处且互相矛盾——`agent_assist.rs:512` 的 `KNOWLEDGE_SEDIMENTATION_RULES`、SkillHub `knowledge-graph/SKILL.md`（含**已失效**的「回写质量门」六条）、以及 `knowledge.rs:919` 的写入格式。最严重的是：提取规则要求 agent「把与图谱冲突的结论标注出来供复核」，而四层门按产品决策**一律拒绝冲突**，失败出口又未落地（ticket 08）⇒ **冲突知识被提出、被拒、无任何出口**。

**修订**（评审稿见 [knowledge-sedimentation-contract-v2.md](./knowledge-sedimentation-contract-v2.md)）：

| 项 | 决定 | 理由 |
|---|---|---|
| 冲突知识 | **不提**（删除「标注需复核」） | 与门「冲突一律拒」一致，从源头消除死胡同。真需要修正时走 §8.3 回滚通路 |
| 条目格式 | 保留两行结构，**去掉恒定的 `· 已确认 ·`** | 只有 `confirmed` 能过门 ⇒ 该标记不携带信息。保留独立「依据」行是**刻意**让自动条目可识别（ticket 08 的回滚依赖它）；若对齐存量「来源内联」风格将无法区分人机条目 |
| `验证记录` | **移出**可写 section | 它是「日期+依据+内容」的流水记录，且写入块本身已带日期与依据，语义重复 |
| `定位` | **移出**可写 section | `module-card-guide.md` 明确「保留 `## 定位` 自动生成部分」 |
| `suggestedTitle` | **删除字段** | 现状从未被使用（不写入、不去重） |
| `knowledgeGraphId` | 改由 Nezha 兜底填入（已在 ticket 11 决定） | agent 写错会导致整份草稿被丢弃，是纯失败源 |
| `confidence` | 保留 | 仍是门的入口条件，只是不再写入卡片正文 |

**实测确认的良性性质**：`normalize_knowledge_text` 本就把「已确认 / 待验证 / 来源 / 括号标注」当噪声剥掉，故去掉 `已确认` **不影响 L2 去重**，无需迁移。

**规则与门的关系**：规则是**提示**（让 agent 不白产），门是**执法**（即使 agent 违反也会拦下）。

**落地属实施第 4 步**（会话内产出契约），本轮未动；且需同步 SkillHub 侧（删失效的门规则六条、同步 section 清单、写入契约文本）。

## 12. 已知限制与遗留

- **HIS/ICUCIS adapter 已删除** ⇒ `scan_available=false`、index 无法重建；**EMR 无 `graph.toml`** ⇒ Nezha 看不见该图谱。属 hub 侧资产缺口。
- **`index.md` 漂移**（101 vs 100）——历史遗留，与沉淀无关。
- **agent 不会自动触发图谱技能**（且 Claude 侧未装任何 hub 技能）⇒ 依赖 prompt 注入指引。
- **`graph.json` 停建** ⇒ 若有后续需求使用它，需重新引入。
- **L3 判定漂移**无法根除，只能靠双跑 + fail-closed 抑制；若「双跑不一致」占比过高（>30%），说明该手段失效，需回到 §9.4 的刹车。
- **「用户确认」类证据**无法机器核验，是 L1 的已知盲点；其可信度依赖任务本身的可信度。
- **纯中文断言 + 引用真实文件**的虚构无法被确定性层识别（§5.2 详述）。这是**本方案最重要的残余风险**：
  L1 只能确认文件存在，而中文用词覆盖率实测无法区分真伪（真实 24%~35% vs 虚构 21%）。
  缓解手段仅剩 L3 语义判定与 §9.3 的抽样审计；若要根治，需要「读代码判断断言是否成立」的能力，
  等于把 L1 重新交回 LLM 并接受其延迟与漂移——本迭代按「宁缺毋滥但接受该盲点」取舍。
- **源码编码**：业务仓库大量 GBK 源码，L1 用有损解码读取。因只比对 ASCII 标识符，判定不受影响；
  但若将来要求在依据文件里做中文内容比对，需引入真正的 GBK/GB18030 解码（当前无此依赖）。
- **依据路径解析采用后缀匹配**：边界是同一段后缀命中多个同名文件时取最短路径。实测 HIS 中
  `Controller/LockNumController.cs` 唯一，无歧义；若某仓库存在多个同名文件，可能解析到非预期那个。

---

## 附录 A：决策索引（地图 → 规格）

| 地图 ticket | 结论落地到 |
|---|---|
| 01 沉淀的生成时机与责任主体 | §4（会话内产出、agent 不写图谱） |
| 02 消费侧图谱读取路径与新鲜度实测 | §1.3、§7 |
| 03 语义去重/冲突检测方案与成本 | §5.3、§5.4（L2/L3 选型，否决 embedding） |
| 04 回放现有质量门，量化重复放行率 | §1.2（全部门设计与阈值的实测依据）、§9.5 |
| 05 质量门重构：分层、判定权与阈值 | §5 |
| 06 跨任务去重：账本与重复判定 | §5.3、§6.5 |
| 07 index.md / graph.json 重建与 push/pull | §6.2、§6.3、§7.3 |
| 08 失败、回滚与可追溯；云效议题；前端 | §8 |
| 09 污染 / 重复的度量与验收口径 | §9 |
| 10 图谱对任务会话的可达性 | §7.1、§7.2 |
| 11 沉淀产出物契约与适用范围 | §4 |

## 附录 B：grill 会话已确认决策（用户逐条拍板）

1. 终点：锁定决策 + 产出设计规格（实现另开 PR）。
2. 把关模式：**直写主干、无人审核**——自动质量门是唯一安全网。
3. 生成时机：整理搬进**任务会话**，主 agent 收尾产候选 JSON，**agent 不拿图谱写权限**。
4. 确定性保障：**强制产出物契约 + 显式 `skipped`**（缺失即「漏了」），不保留 post-hoc 兜底。
5. 依据核验：**Rust 确定性核验**（文件存在 + 含所声称符号）+ 内联卡片的 LLM 做语义判定。
6. 非确定性对策：**双跑一致才放行**，不一致即拒。
7. 去重基准：**不引入账本**，直接比对图谱内容；范围=**整个目标图谱、不跨图谱**。
8. 修正语义：**不做修正，冲突一律拒**（回滚走 §8.3）。
9. 拉取时机：**后台每 15 分钟**自动拉取并提示（已实测开销可忽略）。
10. worktree 可达性：**任务启动时注入环境变量**。
11. Claude 侧缺技能：**不修安装**，改为 agent 无关注入。
12. 契约宿主：**SkillHub 技能**（随 hub 热更新，Nezha 侧承担版本兼容）。
13. 适用范围：**只对绑定图谱的项目**强制。
14. 门规则归属：SKILL.md **只留读取契约**，门规则由 Nezha 定。
15. 云效议题：**只在失败时建**。
16. 回滚粒度：**条目级标记 + 一次沉淀一个 commit**。
17. 触发与入口：**任务完成即自动处理，无手动按钮**。
18. 自动开关：移除 `autoWriteback`，**保留一个总开关**。
19. 重试语义：**先补推未推送提交，再重跑门**。
20. 刹车：**超阈告警 + 一键降级（人工拍板）**，不自动降级。
21. 事后审计：**只定指标与验收，周期 lint 留后续**。
