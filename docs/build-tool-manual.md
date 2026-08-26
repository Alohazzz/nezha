# Nezha 构建工具操作手册

> 对应 PR：https://github.com/Alohazzz/nezha/pull/25 （issue #24）
> 说明：构建面板依赖项目配置中的 `hsp-build-order` 技能脚本（`HSP/SkillHub` 托管），用于解析解决方案与依赖排序。

## 0. 前置条件

- 把目标仓库（如 HIS）注册为 Nezha 项目（项目根即仓库根）。
- 机器需有：VS18 的 `MSBuild.exe`（可在「构建配置」指定，留空自动探测）、NuGet 缓存（`H:\packages\NuGet\cache`，通过 `NUGET_PACKAGES` 或 `NuGet.config`）、共享输出目录（如 `H:\...\可执行程序`，含外部 dll）。
- 构建前先点「**分析/计划**」生成阶段/依赖/环境检查计划（同时生成 `Log\build-plan.json`，供可视化与引用预案）。

## 1. 打开构建面板

进入项目后，点击右侧工具栏的**锤子图标（构建）**，右侧展开「构建」面板（截图见 `docs/build-panel.png`，示例为项目选择页；构建面板位于项目页右侧）。

## 2. 仓库拉取

- 面板「仓库拉取」列出自动推导的仓库：主仓库 + `.gitmodules` 子模块（当前仅展示 HIS / DrugInOut / Term）。
- 每个仓库可**独立切换分支**（下拉），并显示当前分支 / `脏`（有未提交改动）/ `缺失` 状态。
- 勾选要拉取的仓库 → 点「**拉取**」：
  - 拉取走 `git pull --ff-only --no-rebase`；**脏仓库会被阻断**（绝不 stash / reset）。
  - 若远端跟踪引用陈旧导致失败，会自动 `git fetch --prune --force origin` 后重试。
  - 结果显示为压缩摘要（`✓/× 仓库: 摘要`）。

## 3. 分析 / 计划

点「**分析/计划**」：以 `-DryRun` 生成**阶段流水线（7 阶段 + OTHER）**、依赖图、循环组（3 组）、外部 dll 引用清单、**引用健康**（重复引用 / TFM 低于被引用项目）、环境检查（NuGet 还原 / VS18-RID 兼容 / 外部 dll 缺失），并写入 `Log\build-plan.json`。**不编译**。

「环境检查」卡片会显示：外部依赖 dll 引用数、缺失、版本冲突、引用健康问题。

## 4. 构建运行

- **构建模式**：`全量` / `增量`（git-diff 变更 + 反向依赖闭包，需先有成功全量基线）/ `仅失败`（上次失败未勾选项 + 反向依赖方）。
- 点「**运行构建**」：以子进程跑 `hsp-build-order.ps1`，按依赖拓扑（就绪波）编译；每项目写独立临时目录、编完拷回共享目录（避免同名写锁）；`MaxParallel` 控制并发（默认 2，1=串行）。
- 运行中显示：**进度 `N/341 · xx% · 阶段`**、进度条、**用时 `HH:MM:SS`**、原始日志（可展开/清空）。
- 点「**取消**」整树终止（含 MSBuild / dotnet）。
- 构建不自动全屏；可点右上「全屏」进入专注监视器（含失败项目 + 阶段 + 原始输出）。

## 5. 错误清单（CheckList）与修复

- 构建失败后生成「**错误信息列表**」：每个失败项目 + `error` 行 + `依赖失败: ...`（链式）/ `[工具链] ...` 诊断。
- 每项一个 **checkbox**：勾选 = 标记已修复，持久化到 `.nezha/build-fix-status.json`。
- 按钮：
  - 「**发起修复任务**」：新建 agent 任务（local、YOLO 全权限），prompt 指引 agent **先读取 `Log\build-errors.txt` → 总结 → 逐个修复 → 把修复好的项目名写入 `.nezha/build-fix-status.json` 的 `fixed` 数组**。
  - 「**导出错误信息**」：把错误列表写入 `Log\build-errors.txt`，按钮旁显示导出结果。
- 修复后重跑：切到「**仅失败**」模式，只编未勾选的失败项 + 依赖方，快速验证；通过后再「全量」。

## 6. 构建配置

`[build]` 配置项（`.nezha/config.toml`，面板「构建配置」可选改）：
- `script_path`：`hsp-build-order.ps1` 路径（留空自动探测；当前走 SkillHub 托管副本）
- `msbuild_path`：VS18 MSBuild.exe（留空自动探测）
- `max_parallel`：并行度（1=串行，2-8 并行）
- `solution / configuration / platform / external_dll_dir / skip_*`：对应 ps1 参数

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 拉取报 `cannot lock ref ...refs/remotes/origin/...` | 远端跟踪引用陈旧；工具会自动 `fetch --prune --force` 修复，并重试。仍失败则手动 `git -C <repo> fetch --prune --force origin`。 |
| 拉取报 `Cannot rebase onto multiple branches` | 仓库配置 `pull.rebase=true`；工具已用 `--no-rebase` 规避。 |
| 编译 `error CS2012 ... 正由另一进程使用 ... VBCSCompiler` | Roslyn 共享编译服务器锁 `obj`；工具已 `UseSharedCompilation=false` + 编译前 kill VBCSCompiler，避免该类锁。 |
| 失败项目无 error 行 | 多为依赖失败；错误列表会标 `依赖失败: xxx` 或 `(无显式 error，可能为依赖失败)`。 |
| 进度不涨 | 点「分析/计划」重新生成计划（含 `ExternalDllDir`），或检查共享目录是否在写入。 |

## 8. 说明

- `hsp-build-order` 技能已由 SkillHub（`HSP/SkillHub`）托管；构建面板运行其 `scripts/hsp-build-order.ps1`。
- 不修改 `Build.proj / BuildProj.targets / Project.targets / AutoBuild.bat`；不改变 Task 数据模型。
