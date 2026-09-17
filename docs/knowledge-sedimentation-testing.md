# 知识沉淀自动回写：自行测试指南

面向「想自己验证这套链路到底跑不跑得通」的使用者 / 维护者。
分三层，**从便宜到贵**：确定性层回归 → 真实 CLI 的 L3 → 端到端手测。三层互相独立，任一层失败都能定位到具体环节。

设计依据：`docs/proposals/knowledge-auto-sedimentation-v2.md`（§9 度量与验收、§9.5 夹具对照）。
沉淀规则本身（写什么、什么算有价值）的唯一事实源是 SkillHub 的
`knowledge-graph/references/sedimentation.md`——改它即可热更新，无需重编 Nezha。

---

## 0. 前置条件核对

先确认这四条：

| 项 | 本机当前值 | 怎么查 |
|---|---|---|
| 总开关开启 | `true` | `~/.nezha/settings.json` → `knowledge.enabled` |
| 项目绑定图谱 | HIS → `graph_id = "HIS"` | `<项目>/.nezha/config.toml` → `[knowledge] graph_id` |
| 图谱 hub 就绪 | 4 个图谱，HIS 有 101 张卡片 | `~/.nezha/skill_hub.json` → `hubPath` 下的 `knowledge-graphs/` |
| **任务类型匹配** | 仅云效的**方案执行 / 直接执行**任务 | 任务须有 `yunxiaoWorkitemId` 且非 `yunxiaoPlanDiscussion` |

四条**全部成立**时沉淀才会触发。缺任一条的原因各不相同：未绑定图谱的项目连产出要求都不注入
（agent 不会被要求写 `knowledge.json`）；总开关关闭时直接跳过且不记指标；**任务类型不匹配**
（普通任务、方案讨论任务）既不注入产出要求、收尾时也不跑沉淀——所以它们没有沉淀结果属预期，
不是漏读。「没沉淀」先查这四条，别先怀疑门。

> 任务提示词只注入**技能指针**（不再内联契约正文），并把契约文件路径放进环境变量
> `$NEZHA_KNOWLEDGE_SEDIMENTATION_CONTRACT`，由 agent 自己读 SkillHub 的
> `knowledge-graph/references/sedimentation.md`；hub 里读不到该文件时退回 Nezha 内嵌正文。


---

## 1. 确定性层回归（L0 / L1 / L2）——秒级，先跑这个

不调 LLM、不联网、不写任何东西，用真实 HIS 卡片做语料，验证「重复必拒、依据不存在的必拒、真知识必须能过」。

```bash
cd src-tauri
NEZHA_KG_E2E_PROJECT="H:/Project/Company/HIS/Nto.His" \
NEZHA_KG_E2E_CARD="C:/Users/SuYi/.nezha/skill_repos/codeup.aliyun.com-641881e9b9581d62e8f8186e-HSP-SkillHub.git/knowledge-graphs/HIS/data/modules/Nto.His.Register.md" \
cargo test --lib acceptance_deterministic_layers -- --ignored --nocapture
```

**两个环境变量必填**（缺了会 panic）：`NEZHA_KG_E2E_PROJECT` 是**证据路径的解析基准**，必须指向
`Nto.His.Register` 这类模块目录的父目录（本项目里是 `H:/Project/Company/HIS/Nto.His`，不是 HIS 仓库根）；
`NEZHA_KG_E2E_CARD` 是被比对的模块卡片。
夹具目录有默认值（`src-tauri/tests/fixtures/knowledge-gate/`），**不用**设 `NEZHA_KG_E2E_ROOT`。

本机实测（约 1.4 s）：

```
== 真实卡片条目数: 22
[0] dup_verbatim_minus_source  -> REJECT@L2
[1] dup_whitespace_reshuffled  -> REJECT@L2
[2] dup_paraphrase             -> PASS→L3
[3] dup_paraphrase             -> PASS→L3
[4] fabricated_no_such_code    -> PASS→L3
[5] conflict_with_existing     -> PASS→L3
[genuine 20] -> PASS→L3 (依据: ...RegistrationCardController.cs)
[genuine 21] -> PASS→L3 (依据: ...OutFeeController.cs)
```

**怎么读这个输出**：确定性层的职责就是「逐字 / 近逐字重复」与「依据文件不存在」。`PASS→L3` 不是失败——
措辞改写、语义冲突、纯文字虚构本来就不归 L1/L2 管，交给 L3。测试只对 `dup_*` 断言，所以 `ok` 即通过；
它同时带一条反向护栏：真知识必须能通过确定性层（否则门退化成「全拒」的废门）。

> `[4] fabricated_no_such_code` 是**已知限制**，不是 bug：它引用的
> `LockNumController.cs` **真实存在**，且断言是纯中文、不含反引号标识符，中文用词覆盖率无法区分真伪
> （实测真实 24%~35% vs 虚构 21%，设阈值会误杀合法知识）。该行为已被
> `l1_cannot_catch_pure_prose_fabrication_by_design` 固定，生产环境由 L3 承担。

---

## 2. 环境注入检查——秒级

确认「agent 在绑定了图谱的项目里能拿到正确的图谱位置」（worktree 场景靠这条不漏）：

```bash
cd src-tauri
NEZHA_KG_E2E_PROJECT="H:/Project/Company/HIS" \
cargo test --lib acceptance_knowledge_env_on_real_project -- --ignored --nocapture
```

期望输出一行 `... -> graph=HIS dir=...knowledge-graphs/HIS/data`，且断言该目录真实存在。
本项目里这个变量要指向 **HIS 仓库根**（`H:/Project/Company/HIS`），和上面 L1 的基准不同。

---

## 3. L3 语义门（真实 CLI 调用）——约 2~3 分钟

这是唯一会**真发两次模型调用**的测试（双跑一致才放行，防止 LLM 抖动误放行）。跑之前确认对应
agent 的 CLI 在 PATH / 已配置（本机 `codex` 可用）：

```bash
cd src-tauri
NEZHA_KG_E2E_ROOT="$(pwd)/tests/fixtures/knowledge-gate" \
NEZHA_KG_E2E_PROJECT="H:/Project/Company/HIS/Nto.His" \
NEZHA_KG_E2E_CARD="C:/Users/SuYi/.nezha/skill_repos/codeup.aliyun.com-641881e9b9581d62e8f8186e-HSP-SkillHub.git/knowledge-graphs/HIS/data/modules/Nto.His.Register.md" \
NEZHA_KG_E2E_AGENT=codex \
cargo test --lib acceptance_l3_dual_run -- --ignored --nocapture
```

本机实测（131 s）——**这就是验收口径要求的结果**：

```
== 内联既有条目 17 条；涉及模块 1 个
[0] dup_verbatim_minus_source  -> REJECT（同一知识，仅去日期 / 换来源写法）
[1] dup_whitespace_reshuffled  -> REJECT（内容一致，仅排版与来源位置不同）
[2] dup_paraphrase             -> REJECT（同一组表，仅少列一张，无新增知识）
[3] dup_paraphrase             -> REJECT（同一批入口窗体，仅改写措辞）
[4] fabricated_no_such_code    -> PASS（双跑一致 distinct）  ← 与第 1 节的已知限制一致
[5] conflict_with_existing     -> REJECT（与既有兜底逻辑直接矛盾）
```

`[4]` 通过是预期的：L1/L2 拦不住的纯中文虚构，若 L3 也判 distinct 就会放行——这正是 §5.2 记录的残余风险，
也是「事后 `git revert` + 抽样人工」这两个兜底存在的理由。要观察 L3 的拦截能力，看 `[2][3][5]`。

---

## 4. 端到端手测（真实任务 → 图谱里多一条）

前面三步验的是「门」，这步验的是「线」：任务跑完 → 产物 → 门 → 写入 hub → 提交推送 → 指标。

**准备**：找/建一个**绑定了图谱**的项目（如 HIS），新建任务时选 **codex / claude / dsh**。
（三种 agent 都会走这条链路：产出契约只按「绑定了图谱 + 总开关开」注入，与 agent 种类无关。
但注意 **L3 质量门固定用 `claude` 或 `codex` 跑**——任务若用 `dsh`，门会归一化成 `claude`，
所以验 L3 时需要 claude CLI 可用；只看产出落盘则不受影响。）

权限模式给足（要能写文件、跑 git）。任务提示词里明确要求沉淀，例如：

> 排查 XXX 的登记逻辑，把确认的长期有效的项目知识按沉淀契约写入本次任务的
> `.nezha/drafts/$NEZHA_TASK_ID/knowledge.json`。

agent 能读到 `NEZHA_TASK_ID` 与 `NEZHA_KNOWLEDGE_GRAPH_ID` / `NEZHA_KNOWLEDGE_GRAPH_DIR`，
契约文本已拼在 prompt 末尾。

**四个观察点，按时间顺序：**

1. **产物落盘**——任务运行中/结束时看 `<项目>/.nezha/drafts/<taskId>/knowledge.json`。
   注意 worktree 任务写在 worktree 里，**任务结束后被后端收拢回项目根**才是沉淀读到的位置。
   没有知识可沉淀时 agent **也必须**写 `{"version":1,"skipped":true,...}`；文件**缺失**会被判为
   「漏了」并报错（这是「确实没有」与「忘了写」的区分点），失败原因就是那句
   `本次任务未产出知识沉淀产物`。
2. **任务结束后的入口**——RunningView 里 `done` 状态的任务右侧会出现
   **「沉淀结果」** 按钮（沉淀进行中显示「正在后台沉淀知识…」且不可点）。点开是只读弹窗：
   写入/拒绝条数 + 逐条理由 + 判定层次（L0/L1/L2/L3/write）。失败时会同时弹 toast，
   并自动给你开一个「知识沉淀未完成」的议题。
3. **hub 里的提交**——去 `hubPath`（`~/.nezha/skill_hub.json` 里的那个路径）下：
   ```bash
   HUB="C:/Users/SuYi/.nezha/skill_repos/codeup.aliyun.com-641881e9b9581d62e8f8186e-HSP-SkillHub.git"
   git -C "$HUB" log --oneline -5
   # 期望看到：docs(knowledge): auto sediment <N> entries via Nezha
   git -C "$HUB" show HEAD          # 看追加了什么（日期 · 置信度 · 内容 + 依据）
   ```
   写入格式是**在对应 section 末尾追加**，只增不改。参考真实样例：commit `5c3565a`
   往 `Nto.His.MRA.md` 追加了一条带日期与依据的条目。
4. **指标**——`~/.nezha/knowledge-metrics.jsonl`（JSONL，追加写，成功/失败都记）。
   ```bash
   tail -3 ~/.nezha/knowledge-metrics.jsonl
   ```
   每行含 `status`（ok/failed/skipped）、`written`、`rejectedByLayer`、`pushedPending`。
   未绑定图谱的项目**不记**（避免给分母灌水）。目前该文件在本机**还不存在**——跑通一次 E2E 后才会出现。

**幂等性验收（提案 §9.5 明确要求）**：把同一个 `knowledge.json` 再喂一次（例如重跑任务时让 agent
写出相同内容），**期望不产生重复条目**——L2 规范化判重会拦下它。这是最能暴露「门形同虚设」的一项。

---

## 5. 顺手可做的排查

- **想看门到底怎么判的**：沉淀是后台任务，日志在 `tauri dev` 的终端（`[knowledge] ...` 前缀）；
  逐条理由也能在「沉淀结果」弹窗里看到，不用捞日志。
- **hub 写锁**：单次沉淀最长可能等 10 分钟（hub 后台同步 15 分钟一轮，两者真互斥）。
  前端有兜底超时把按钮从「正在沉淀」恢复，属正常自愈，不是卡死。
- **想手工触发一次写入**（不经任务完成链路）：后端命令 `knowledge_auto_writeback` 是注册过的，
  参数为 `projectPath` / `suggestions[]` / `agent`；可直接从 devtools 调用来单独验写入与提交段。
- **回滚误放行**：沉淀只增不改，冲突一律拒；真写错了走 `git revert` 那笔
  `docs(knowledge): auto sediment ...` 提交。

---

## 已知限制（测到「该拒没拒」时先看这里）

| 现象 | 是不是 bug |
|---|---|
| 纯中文虚构 + 引用真实文件 + 不含代码标识符，被放行 | **不是**，设计内；L1/L2 无能为力，靠 L3 + 事后抽样人工 + revert |
| 一次沉淀的模型调用次数为 `2 × 分块数`，没有 wall-clock 预算 | **不是**，本期刻意未做 |
| 「知识需要修正」不取代旧条目，一律拒 | **不是**，冲突不做取代语义，走 `git revert` |
| 前端 `file-viewer-language` / `yunxiao-project-switch` / `yunxiao-version-filter` 在全量并发下偶发失败 | **不是**本特性回归；单独跑必过，改动前 `d4c44cf` 同样复现（CodeMirror 跨实例已知问题） |
