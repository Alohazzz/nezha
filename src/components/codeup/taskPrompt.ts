import type { CodeupMr } from "../../types";

export type CodeupTaskKind = "review" | "conflict" | "merge";

const conflictInstructions =
  "git merge 因冲突返回退出码 1 是预期中间状态，必须继续解决，不能仅因该退出码停止或请求用户手工解决。" +
  "git apply、patch 或搜索替换失败只表示补丁与当前文件上下文不匹配；重新读取当前文件和双方差异，调整补丁或使用编辑工具逐段修改，继续解决，不得因此结束任务。" +
  "运行 `git diff --name-only --diff-filter=U` 列出冲突，逐个读取双方及共同祖先，按业务意图合并修改；禁止整批选择 ours/theirs 或丢弃任一侧功能。" +
  "修改后逐文件 git add，再检查未合并文件列表为空、`git diff --check` 和 `git diff --cached --check` 通过，运行相关验证后继续提交与推送。" +
  "仅对鉴权/网络/仓库损坏等真正错误，或查阅代码仍无法确定的业务取舍，保留现场并报告具体阻塞原因；不得把普通文本冲突当作阻塞。\n";

export function buildCodeupTaskPrompt(mr: CodeupMr, kind: CodeupTaskKind): string {
  let prompt: string;
  if (kind === "review") {
    prompt =
      `──── 代码审查（规则与输出由 \`merge-code-review\` 技能统一管理）────\n` +
      `请读取并遵循 \`merge-code-review\` 技能：\`~/.codex/skills/merge-code-review/SKILL.md\`（审查规范在 \`references/csharp-dev-manual.md\`）。对 \`git diff origin/${mr.targetBranch}...origin/${mr.sourceBranch}\` 的改动按技能规则逐项审查；读文件内容用 \`git show origin/${mr.sourceBranch}:<path>\`。\n` +
      `不要输出结构化 <REVIEW> JSON 数组。请汇总本次改动发现的全部问题，写出一份**对人可读的整体审查总结报告**：按规则分组、标注严重程度（warn/fail）、文件路径与行号、问题说明与修改建议，并在报告末尾给出「是否可合并」结论。\n` +
      `完成后把该 Markdown 报告写入当前工作区 \`.nezha/review-report-${mr.localId}.md\`（用相对工作区根路径，不要写绝对路径）。\n` +
      `同时把逐项判定写成 JSON 数组，写入当前工作区 \`.nezha/review-${mr.localId}.json\`（同样用相对路径）：每项形如 {"rule":"规则名","status":"pass|warn|fail","path":"文件相对路径","startLine":行号,"endLine":行号,"message":"原因/建议"}；每条审查规则至少一条判定，无问题的规则给 status=pass；status 只能取 pass/warn/fail。`;
  } else if (kind === "merge") {
    prompt =
      `你是 MR 合并助手。分支获取、合并、提交和推送使用 git 命令，不得调用平台/接口合并。允许使用文件读取、编辑工具解决冲突，并运行相关的构建、测试和验收命令。\n` +
      conflictInstructions +
      `把 S = origin/${mr.sourceBranch} 落地到 T = origin/${mr.targetBranch}，工作分支 codeup-mr-${mr.localId}，落地形式：允许 fast-forward。\n` +
      `1. 分别运行 \`git fetch origin ${mr.sourceBranch}\` 与 \`git fetch origin ${mr.targetBranch}\`，记录并报告两个 SHA。\n` +
      `2. 运行 \`git checkout -f -B codeup-mr-${mr.localId} origin/${mr.sourceBranch}\`。\n` +
      `3. 若 T 不是 S 的祖先（\`git merge-base --is-ancestor origin/${mr.targetBranch} origin/${mr.sourceBranch}\` 返回非 0）：运行 \`git merge --no-commit --no-ff origin/${mr.targetBranch}\`，有冲突就改代码解决，禁止 \`git merge --abort\`，然后运行 \`git add -A && git commit -m "merge ${mr.targetBranch} into ${mr.sourceBranch}"\`。若 T 已是 S 的祖先，跳过本步。\n` +
      `4. 判定 MR 有无净贡献，方向是 S→T，不得拿 merge 的输出当依据（Already up to date 也算有内容）：运行 \`git diff --stat origin/${mr.targetBranch} HEAD\`，为空才报告「无新增内容，无需合并」并停止；不为空则继续。\n` +
      `5. 运行 \`git ls-remote origin refs/heads/${mr.targetBranch}\` 确认远端未变，再运行 \`git push origin HEAD:${mr.targetBranch}\`。默认走 fast-forward；仅当任务明确要求保留合并提交时才改用 \`git checkout -B tmp origin/${mr.targetBranch} && git merge --no-ff codeup-mr-${mr.localId}\` 后 \`git push origin HEAD:${mr.targetBranch}\`。\n` +
      `6. 报告落地形式、前后 SHA、解决冲突的文件。\n` +
      `禁止平台合并、force push、merge --abort。git merge 有冲突时按上述冲突流程继续解决；其他命令失败时先检查原因，无法恢复才保留现场并报告。\n` +
      `完成后简要说明结果。`;
  } else {
    prompt =
      `你是合并冲突解决助手。请在当前工作区按步骤完成并把结果推回源分支：\n` +
      conflictInstructions +
      `1. 运行 \`git fetch origin ${mr.targetBranch}\`\n` +
      `2. 运行 \`git merge --no-commit --no-ff origin/${mr.targetBranch}\`\n` +
      `3. 若存在冲突，按上述流程继续解决，禁止 git merge --abort；若无冲突且 MERGE_HEAD 存在，执行 \`git merge --abort\` 后报告无冲突并结束；若已是最新则直接报告无冲突并结束，不再执行提交和推送\n` +
      `4. 解决后运行 \`git add -A\` 与 \`git commit -m "resolve merge conflicts"\`\n` +
      `5. 运行 \`git push origin HEAD:${mr.sourceBranch}\`\n` +
      `完成后简要说明结果。`;
  }
  return prompt;
}

/** Continue in the existing checkout; repeating initial checkout would destroy the resolution. */
export function buildCodeupMergeContinuation(
  kind: "merge" | "conflict",
  sourceBranch: string,
  targetBranch: string,
): string {
  const destination = kind === "merge" ? targetBranch : sourceBranch;
  return (
    "Git 检查确认本次合并仍未完成，请在当前会话和当前工作区继续解决，不要把上一轮结束当作合并完成。\n" +
    "保留当前修改，先读取 git status、MERGE_HEAD、冲突文件与已暂存差异；禁止重新 checkout -f、reset --hard、清理工作区或 git merge --abort。\n" +
    conflictInstructions +
    `恢复先前失败的补丁时，核对 origin/${sourceBranch}、origin/${targetBranch} 与共同祖先，确认源分支的新增逻辑全部保留，不得把单选 theirs/ours 当作解决。\n` +
    `完成冲突修改和验证后，提交合并结果，再检查远端分支是否前进并以 fast-forward 方式执行 git push origin HEAD:${destination}；禁止 force push。\n` +
    "只有完成提交并确认推送成功，才报告合并完成。只有确实无法确定业务意图或无法恢复的环境错误才报告具体阻塞，不要因一次补丁失败停下。"
  );
}
