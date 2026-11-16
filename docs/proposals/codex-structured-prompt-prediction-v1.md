# Spec：Codex structured 下一条 Prompt 预测

日期：2026-11-12

状态更新（2026-11-16）：已实施并完成验收，默认开启；证据、支持范围和验证限制见[验收报告](../research/codex-prompt-prediction-acceptance.md)。以下原始需求保持不变。

范围：Nezha 的 Codex structured 续聊输入框。

## 1. What / Why / Scope

### What

在 Codex structured 任务正常结束一轮后，后台预生成一条最可能的下一步用户 Prompt。用户回到空输入框时即可看到建议，按 Tab 转为可编辑草稿，再按现有发送快捷键发送。

### Why

当前一轮任务结束后，用户需要从回复中重新组织下一步指令。常见下一步已经隐含在对话里，例如将调查结论整理成 Spec、按确认方案实施、运行验证。预测应延续用户当前意图，减少重新组织语言的成本；不应推荐泛泛的“还可以做什么”。

流畅体验来自回复结束即预生成、按轮次缓存、输入框即时呈现，而不是逐键发请求。预测属于可丢弃的辅助工作，正常输入、发送、恢复和退出始终优先。

### Scope

- 首期仅 `agent=codex` 且 `runMode=structured`、本轮成功完成、可以继续对话的任务。
- 任务来源不作为区别：普通任务、云效直接开始/讨论/执行等符合相同条件时使用相同逻辑。
- 首期只在本次 Nezha 运行期间观察到的成功完成轮次上生成；再次打开同一轮读取缓存，不重算。应用重启后的历史任务补生成不在首期范围。
- 不支持 Claude、Codex PTY、新建任务输入框、运行中 steer 输入框、失败/中断/取消轮次。
- 不在 Plan 模式、待审批/待用户回答、自动继续循环或仍有待发送指令时预测；这些状态须使用实际结构化状态识别，不能仅凭任务来源猜测。
- 不接入 Codex 桌面端私有登录存储、`/wham/predictions/config` 或云端 prediction HTTP 接口。
- 不修改 `TerminalView.tsx`、`terminalShared.ts`、`useTerminalManager.ts` 或 PTY 输出链路。

## 2. 调查依据与版本边界

2026-11-12 调查确认：

1. Codex 桌面端 26.1106.6628.0 的本地预测调用 `thread/sample`，基于原线程和最新 turn；先生成，空输入框展示，接受后不自动发送。
2. 当日服务端预测 Prompt v5 要求以用户口吻输出单行、最多 240 字符的下一条消息，允许 null；配置 reasoning effort 为 high。
3. 桌面端在本地路径使用父线程模型，而非固定小模型。
4. 公开后端 commit `c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee` 中，sample 创建继承历史的 ephemeral fork，禁新的自动压缩，在 Core 执行前截获模型响应，工具调用返回空结果。
5. 继承的是父线程当前模型可见上下文：已有压缩检查点、后续消息和上下文状态。工具输出依模型策略/元数据裁剪，不是固定最近 N 条，也不是全部原始 JSONL。
6. 本机后端为 0.167.0-alpha.4.1；上述公开 commit 不是已验证与该二进制完全一致的源码。不得仅凭版本号假定所有 sample 语义都可用。
7. Nezha 当前 Cargo 固定的 `83086188ae0614bd882818ff1aa23f3194962012` 不含 `ThreadSample` 类型；实施时需解决协议类型/能力适配。

可复核的永久源码：

- [thread/sample 实现](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/app-server/src/thread_sample.rs)
- [模型上下文加载](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/thread-store/src/local/model_context.rs)
- [历史重建](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/core/src/session/rollout_reconstruction.rs)
- [工具输出裁剪](https://github.com/openai/codex/blob/c0cc9fc820f62e4dbdde68214dd6d792d6c8a7ee/codex-rs/core/src/context_manager/history.rs)

## 3. 用户交互契约

### 3.1 草图

```text
改前（任务已完成）
┌──────────────────────────────────────────────┐
│ 继续对话…                                    │
│                                      [发送]  │
└──────────────────────────────────────────────┘

改后（后台已有建议，输入框为空）
┌──────────────────────────────────────────────┐
│ 将这些结论整理成一份可实施的 Spec。  [Tab 接受]│ ← 提示层，不是输入值
│                                      [发送]  │
└──────────────────────────────────────────────┘

按 Tab 后
┌──────────────────────────────────────────────┐
│ 将这些结论整理成一份可实施的 Spec。|          │ ← 正常草稿，可编辑
│                                      [发送]  │
└──────────────────────────────────────────────┘
```

### 3.2 展示条件

同时满足下列条件才显示：

- 当前任务是对应 thread/turn 的完成态，预测缓存有效且功能开启。
- textarea 的实际值长度为 0。空格、换行也属于用户输入，不自动 trim 后判空。
- 无图片、文本、文件或引用附件；附件存在时保留原占位行为。
- 未处于 IME composing（包括 keyCode 229）、提及/斜杠弹层、提交锁定状态。
- 本轮未被用户接受或主动编辑后抑制；迟到预测不得恢复已抑制的提示。

提示层不写入 textarea.value，不抢焦点，不改变 selection，不影响粘贴、选字、拖放或高度计算。无建议/生成中/错误时使用原占位符，不显示 spinner、错误 toast 或禁用输入框。

建议展示最多两行，窄面板自然换行；长内容省略不溢出，“Tab 接受”提示不遮住输入。只在输入框已有焦点时展示按键提示。暗/亮主题均使用项目主题变量，低强调但保持可读对比度。

### 3.3 按键与编辑

- 仅 textarea 聚焦、建议可见、无修饰键的 Tab 才接受建议并 preventDefault。
- Shift+Tab、无建议的 Tab 保持原焦点导航；不增加全局键盘监听。
- IME 和提及菜单优先于预测处理；组合输入期间 Tab 不接受建议。
- 接受后作为一笔可撤销的草稿编辑进入现有草稿状态，光标置末尾，本轮不再提示；不得自动发送。
- Enter、Shift+Enter、Escape 继续原有行为；不复制 Codex 桌面端可能存在的 Enter/右箭头接受行为。
- 用户键入、粘贴或加入附件后立即隐藏并抑制本轮建议；删除这些内容后也不重新弹出。接受后撤销至空同样不重新提示。
- 程序化同步非空草稿也必须隐藏建议；模型/effort/模式/权限或线程发生变化时清除旧缓存。
- 无障碍：提供可读的建议及 Tab 操作说明；不使用持续 live region 打断屏幕阅读器，不用提示层替代 textarea 标签。

## 4. 生成策略和协议

### 4.1 本地固定策略

- 应用级 `codex_prompt_predictions_enabled: boolean`，默认 true；仅符合能力条件时生效。通用设置提供开关，说明“根据当前对话后台生成下一条建议，会产生额外模型用量”。旧配置缺字段使用默认值。
- 关闭立即取消所有预测、清缓存并释放预测保留的会话；不打断正在运行的用户任务。
- 使用父线程已生效模型；预测 effort 初版 high，不改写父线程 effort 或用户模型设置。
- 首期每个成功完成轮次最多请求一次，生成比例 100%；不照搬服务端 A/B 采样率。
- 同时最多 2 个预测请求（跨项目）；无空槽时跳过该轮，不为辅助任务无限排队或占住会话。
- 预测端到端 30 秒截止，包括准备/请求/响应处理；不自动重试。
- 已生成结果保留于内存，最多 100 个轮次、LRU 淘汰；不落 tasks.json，不修改 Task 数据结构。

### 4.2 请求与返回

示意字段须在支持的实际 CLI 上验证后落地：

```json
{
  "method": "thread/sample",
  "params": {
    "threadId": "<source thread>",
    "expectedTurnId": "<last successfully completed turn>",
    "prompt": "<local versioned prediction prompt + JSON schema>",
    "effort": "high",
    "threadSource": "composer_predictions",
    "turnTrigger": "composer_predictions",
    "disableMcp": true
  }
}
```

- 单独维护本地版本 `nezha-next-message-v1`，以服务端 v5 的意图为基线，完整提示词见附录。
- JSON schema 为仅包含 `suggestion: string | null` 的对象。解析拒绝代码围栏、多个候选、解释、非 JSON、空白串、换行及超长串；不对错误结果发起修复请求。
- 长度按 Unicode code point 计算，最多 240；Rust/TS 使用一致的规则。只 trim 首尾空白，不把多行拼成一行。
- 返回空 text、null suggestion、工具调用结果、超时及协议错误统一作为“无建议”，不修改任务状态。
- `disableMcp` 不等价于工具执行保证。必须验证选用的 sample 版本有响应拦截；禁止用普通 `turn/start`、持久化 fork 或向原线程追加预测消息来替代。
- sample 请求的 request ID 必须可追踪、可取消；取消使用 `thread/sample/cancel`，仅在支持时使用 `interruptOnCancel`。
- 保留原任务权限、cwd 和线程设置；预测不得触发执行、文件写入、审批、提问、通知、沉淀或云效回写。

### 4.3 能力兼容

建立本进程生命周期内的能力状态：unknown / supported / unsupported。

- 优先使用 CLI 公布的能力/协议元数据；版本只能作为初筛，不能单凭 `>= 某版本` 宣称安全语义已验证。
- 无明确能力字段时，使用经集成测试确认的兼容版本范围，首次合法完成轮次的请求作实际确认；method-not-found / 不支持字段关闭本实例能力，后续不重复探测。
- 身份、模型或临时网络错误不得永久归类为协议不支持；本轮无建议即可。
- 对不支持/未知且不在已验证范围的版本，保持原体验，不自动降级 PTY、不弹更新提示、不自动更新用户 CLI。
- Nezha 老 protocol crate 可在专门模块使用本地 serde DTO + 现有 JSON RPC；不要为一个方法未经评估升级全套依赖。
- 具体支持矩阵、模型 effort 支持情况必须在实现交付时补齐；未完成 sample 无工具执行验证不得启用该版本。

## 5. 生命周期：先保证恢复，再考虑预测

### 5.1 当前约束

`task_bridge.rs` 的 `TurnCompleted` 调 `finish_done` 后结束 forwarder，随后清 session 并 `shutdown_shared`；`resume_structured_task` 当前总是另起 app-server。`mod.rs` 在完成后清 `current_turn_id`。

直接在完成后调用 sample 会遇到进程已关闭；另起预测进程恢复同一 thread 又会与正常恢复争夺 writer lock。首期采用**同一会话短暂保留，并可由用户恢复接管**，不启动额外预测 app-server。

### 5.2 单一会话所有者

引入任务级生命周期协调器，分离“业务轮次结束”和“会话进程释放”：

| 状态 | 行为 |
|---|---|
| Running | 正常 forwarder，禁止预测 |
| IdlePredicting | 业务已 done，保留原 session，后台 sample |
| IdleWarm | 建议已完成/为空，短暂保留 session 供用户恢复 |
| Resuming | 用户提交已取得独占恢复权，旧预测失效 |
| Closing / Closed | 统一取消、清表、关闭，不接受迟到回调 |

- 正常完成时立即保留 `last_completed_turn_id`，按原流程发布 done、完成通知及业务收尾；预测不延迟这些动作，也不增加运行任务计数/时长。
- 原有完成处理只执行一次；新增后台状态不得再次触发 `finish_done`、附件清理、沉淀或回写。
- 主线程的事件转发继续可用，预测子线程响应不进入主任务消息列表。不得将 sample 的内部事件误当原任务 running/done。
- 会话拥有唯一 owner 和递增 `sessionGeneration`；旧 forwarder 清理只能 compare-and-remove 自己的 generation，不能删除已被恢复接管的会话。
- 锁内只读写状态/令牌，不执行 RPC、等待或 I/O。取消、收尾和进程关闭均幂等。
- warm 保留从业务完成时起最长 60 秒，预测最长 30 秒；建议缓存可以比进程活得更久。
- 全局最多 2 个非 Running 保留会话，预测和 warm 共用预算；无预算则跳过预测并按原流程关闭。用户恢复不受该预算限制。

### 5.3 用户恢复优先

1. 现有发送入口首先以任务/thread ID 取得协调器恢复权，递增 generation，清本轮建议，取消预测及 warm 定时器。
2. 有健康保留会话：向 sample 发取消并验证父线程可开始新 turn；沿现有输入校验、附件落盘、模型覆盖、输出 Channel/事件绑定流程，在原 session 开始用户 turn。
3. 不等待预测生成结果或其 30 秒超时。取消/父线程就绪握手预算初定 250ms；可直接恢复的父线程不人为等待该预算。
4. 无法确认可复用或连接已损坏：关闭旧 session，并确认进程/写锁释放后执行现有冷恢复流程。不能旧 writer 未释放就盲目 spawn 重试。
5. 取消失败不能把任务置 failed；真正的用户恢复失败才沿原有失败提示处理。不得吞掉、重复发送或自动重放用户 Prompt。

250ms 是实现验收目标，不是假定协议保证。若目标 CLI 的取消语义不能满足，须先调整协调方案并更新 Spec；不得以偶发卡住恢复为代价保留预测。

关闭项目/删除任务/切换模式/应用退出/取消或 reset：统一撤销预测、清缓存和释放保留 session。单纯切换选中任务只隐藏界面，不取消已经在途的预测；仍受并发和 60 秒上限约束。

## 6. 前后端边界和缓存一致性

后端拥有能力状态、调度、session 生命周期和结果缓存；前端拥有草稿、展示、接受及本轮抑制状态。

结果键至少包含 `taskId + threadId + sourceTurnId + sessionGeneration`；结果元数据包含 `promptVersion`、生效模型/effort、创建时间。模型/模式变更要主动使键失效。

建议接口（命名可随项目惯例调整，语义不得弱化）：

- `get_codex_prompt_prediction(taskId, threadId)`：只读有效缓存，不因组件 mount 重发模型请求。
- `codex-prompt-prediction` 事件：提供结果/失效和完整关联键；只携带短建议及元数据，不广播历史上下文。
- 前端先订阅再读取缓存；响应和事件都校验当前 task/thread/turn/generation，避免切任务或恢复时闪现旧建议。新建组件不读取另一个任务的缓存。
- 用户编辑不需要逐键调用 Tauri；前端立即抑制本轮展示，后台最多已在途的一次请求可自然完成。真正提交时由后端恢复入口取消预测。
- 用户接受后的文本遵循现有草稿存储行为；预测缓存本身不持久化。
- 命令仅按 TaskManager 已登记任务定位 session，不接受任意会话路径；新增命令在 lib.rs 注册，前端 invoke 使用返回类型。

## 7. 文件与实施拆分

| 模块 | 责任 |
|---|---|
| `src-tauri/src/codex_appserver/prediction.rs`（新增） | DTO、能力适配、提示词、解析、调度/缓存及取消 |
| `src-tauri/src/codex_appserver/session_lifecycle.rs`（建议新增） | 唯一会话所有者、warm 预算、恢复接管、幂等清理 |
| `mod.rs` / `rpc.rs` / `task_bridge.rs` | sample 传输、完成 turn 标识、forwarder 与恢复集成 |
| `app_settings.rs` / 对应 TS 设置类型与通用设置 UI | 开关、默认值、保存与迁移 |
| `src/components/codex-stream/usePromptPrediction.ts`（新增） | 订阅、缓存读取、关联键校验、显示/抑制状态 |
| `src/components/codex-stream/CodexComposer.tsx` | 提示层、Tab 接受与现有草稿编辑整合 |
| `src/styles/` 相应模块 | 暗亮主题、窄宽布局、提示层样式 |

不引入外部状态库。新增组件控制 400 行以内；拆分逻辑而非继续堆入大文件。修改 CodexComposer 时须按仓库规范迁出其存量 inline style，不新增业务 CSS 文件。

实施顺序：

1. 协议验证：受控 fixture 验证 sample 可用、继承上下文、无工具执行、取消与父线程不被污染，产出支持矩阵。
2. 生命周期：先实现保留/接管/清理及竞态测试，证明预测关闭时正常流程不变。
3. 预测后端：本地提示词、结果验证、调度、缓存和设置。
4. 输入框：提示层和 Tab 草稿编辑，补齐多状态 UI 验证。
5. 端到端：真实模型测试、恢复延迟对照、进程/锁泄漏验证，再启用默认开关。

后续进入代码/PR 阶段按仓库 issue-first 规则核对是否已有接受的提案或适用例外；本文不是已发布的 GitHub issue。用户本次仅要求本地 Spec，不自动开 issue、提交或推送。

## 8. 验收与测试矩阵

| 场景 | 必须结果 |
|---|---|
| 成功完成且输入框为空 | 后台一次请求；done 及时发布；结果到达后展示 |
| 已有文字/空格/换行/附件 | 不覆盖、不展示建议，正常发送 |
| 生成中输入、粘贴、接受后撤销 | 用户文字不丢失；本轮建议不重新弹出 |
| Tab / Shift+Tab / Enter / IME / 提及菜单 | 仅合格的裸 Tab 接受；其余语义不变 |
| 用户在 sample 请求前/中/刚返回时恢复 | 一次用户 turn；旧建议失效；不等预测超时 |
| 切换任务再切回 / mount 与事件同时发生 | 不串任务，不丢有效缓存，不重算 |
| 模型/effort/权限/运行模式改变 | 旧结果失效；不修改父线程配置 |
| 不支持协议 / 无权限 / 限流 / 断网 / 超时 | 无建议，原任务和恢复仍可用，无错误 toast |
| 返回 null/坏 JSON/多行/241 字符/工具调用 | 无建议；不执行工具、不请求用户审批 |
| failed/interrupted/cancelled/Plan/自动继续 | 不生成；没有误触发完成通知或回写 |
| 两个以上任务同时完成 | 最多两个辅助请求/保留会话；其他任务正常收尾 |
| 关闭项目/退出/超时关闭与恢复竞态 | 不误杀新 session，无残留 writer 锁或孤儿进程 |
| 连续至少 20 次完成→预测→恢复 | session/子进程数量受控、消息无重复、原线程无预测 Prompt |
| 暗/亮主题、窄/宽、焦点与无焦点 | 不溢出、不跳布局、不抢焦点，建议与真实草稿可区分 |

性能验证使用同机、同 CLI、同任务 fixture，对比开关关闭的冷恢复基线；记录发送到 turn/start 应答及首次输出、取消耗时、输入渲染耗时，报告中位数/P95和异常样本。warm 恢复不因 sample 等待 30 秒；回退冷恢复只承担有界旧会话清理，不能无限等待。输入路径不引入网络调用或上下文序列化；建议到达不触发全局大列表重渲染。

测试分层：纯解析/缓存键测试；fake RPC 时序与取消测试；React 输入/IME/焦点测试；实际 CLI 集成验证；桌面暗亮窄宽截图。实现在合适范围运行类型检查、Rust 测试、相关 Vitest 与构建；文档阶段不运行这些测试。

可观测性仅记录关联 ID、版本、模型、耗时、token（若返回）、结果类型、取消/失效原因；默认不记录原始对话、完整建议或凭据。生成失败日志只作调试，避免用户可见噪声。无新增外部遥测。

## 附录 A：本地预测提示词基线

本地版本 `nezha-next-message-v1`。以下英文文本取自 2026-11-12 实际获取的服务端 v5，作为行为基线；Nezha 将自行维护，不运行时拉取私有配置：

```text
This is an app-generated request for a suggested next user message. The user did not write this message.

Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.

Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.

Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation.

Return only JSON matching this schema: {"type":"object","properties":{"suggestion":{"type":["string","null"]}},"required":["suggestion"],"additionalProperties":false}.
```

最后一行是 Nezha 明确选定的输出约束，不宣称与桌面端运行时 schema 序列化逐字相同。提示词要求不能替代后端响应拦截与长度/格式校验。
