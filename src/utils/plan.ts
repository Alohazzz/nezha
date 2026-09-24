/**
 * 多议题联合方案（Plan）纯函数：路径推导、方案文档节提取、讨论/执行提示词组装。
 * 与后端约定保持一致：plan.md 节标题格式 `## <议题编号> <标题>`、测试小节
 * `### 影响范围与测试`（契约由 SkillHub `yunxiao-plan-discussion` 技能维护）。
 */
import type { Plan, Task, TaskStatus, YunxiaoWorkitem } from "../types";
import { normalizeIssueDescription, getYunxiaoPriority } from "./yunxiao";
import { buildTaskBySerial } from "./planQueue";

/** 方案显示名：有自定义名用自定义名，否则由议题编号拼（看板/面包屑统一口径）。 */
export function planTitle(plan: Pick<Plan, "name" | "issues">): string {
  if (plan.name.trim()) return plan.name;
  return buildPlanDisplayName(plan.issues.map((issue) => issue.serialNumber));
}

/**
 * 方案的祖先链：从**直接父级**到根，顺序排列（决策 D-b：`dependsOn` 可引用整条祖先链）。
 *
 * 两级守卫，都只「停在断点」而不抛错——祖先链只用于放宽引用范围与提供展示归属，
 * 解析不出祖先时子方案照常工作（未被放行的编号由 `parsePlanDeps` 丢边并告警）：
 * - 链上出现重复 id（`parentPlanId` 成环）→ 停在重复节点；
 * - 父方案已被删除 / id 不存在 → 停在断点（祖先集合只含仍存在的方案）。
 */
export function planAncestorChain<T extends Pick<Plan, "id" | "parentPlanId">>(
  planId: string,
  plans: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const plan of plans) byId.set(plan.id, plan);

  const chain: T[] = [];
  const visited = new Set<string>([planId]);
  let current = byId.get(planId)?.parentPlanId?.trim();
  while (current) {
    if (visited.has(current)) break;
    const parent = byId.get(current);
    if (!parent) break;
    visited.add(current);
    chain.push(parent);
    current = parent.parentPlanId?.trim();
  }
  return chain;
}

/** 祖先链（含父 / 祖父…）的议题编号合集，供 deps.json 引用放宽与 Checklist 标题来源共用。 */
export function planAncestorSerials(planId: string, plans: readonly Plan[]): string[] {
  const serials: string[] = [];
  for (const ancestor of planAncestorChain(planId, plans)) {
    for (const issue of ancestor.issues) serials.push(issue.serialNumber);
  }
  return serials;
}

/** 项目内方案目录：`<project>/.nezha/plans/<planId>/`。 */
export function planDirPath(projectPath: string, planId: string): string {
  return `${projectPath.replace(/[\\/]+$/, "")}/.nezha/plans/${planId}`;
}

/** 方案文档绝对路径。 */
export function planMdPath(projectPath: string, planId: string): string {
  return `${planDirPath(projectPath, planId)}/plan.md`;
}

/** 方案依赖文件绝对路径（契约见 SkillHub `yunxiao-plan-discussion`「方案依赖文件」节；
 *  与后端 get_plan_discussion_instructions 注入给 agent 的路径同一约定）。 */
export function planDepsPath(projectPath: string, planId: string): string {
  return `${planDirPath(projectPath, planId)}/deps.json`;
}

/** 议题在方案图片目录下的归档目录（与后端 prepare_issue_images 的 plan 分支一致）。 */
export function planIssueImagesDir(projectPath: string, planId: string, workitemId: string): string {
  return `${planDirPath(projectPath, planId)}/images/${workitemId}`;
}

function categoryLabel(categoryId?: string): string {
  const category = (categoryId ?? "").trim().toLowerCase();
  if (category === "bug") return "Bug 缺陷";
  if (category === "req") return "Req 需求";
  if (category === "task") return "Task 任务";
  return "未知类型";
}

/** 方案讨论提示词：议题清单（编号/标题/元信息 + 原文文件路径）+ 附件图片 + 发起人补充 + 后端注入的联合讨论指令。 */
export function buildPlanDiscussionPrompt(input: {
  issues: YunxiaoWorkitem[];
  /** 议题原文落盘路径（后端 `yunxiao_prepare_issue_images` 产出）：正文可能很长且含图片占位，
   *  一律写文件、prompt 只给路径——避免大段正文进命令行（Windows 32,767 上限，os error 206）。 */
  issueTextPathByIssue: Record<string, string>;
  imagePathsByIssue: Record<string, string[]>;
  linksByIssue: Record<string, string>;
  /** 发起人在对话框手动补充的内容（背景描述/参考资料/已有修改方案等），可空。 */
  userNotes?: string;
  /** 追加子方案时的上游方案上下文（`buildUpstreamPlanContext` 产出），可空。 */
  upstreamContext?: string;
  instructions: string;
}): string {
  const pieces: string[] = [];
  // 单议题与多议题共用 plan 链路，但框架口吻按议题数自适应，避免单议题被「跨议题统筹」带偏。
  pieces.push(
    input.issues.length === 1
      ? "你是「议题方案讨论助手」。请先读取下方每个议题的原文文件，完整读懂议题，再按指定流程完成方案讨论。目标：产出该议题的方案文档（含修改方案与测试向内容），写入指令中指定的位置，供后续生成待办执行与回写云效。"
      : "你是「多云题联合方案讨论助手」。请先读取下方每个议题的原文文件，完整读懂全部议题，再按指定流程联合分析。目标：产出一份覆盖全部议题的统一方案文档（含跨议题统筹与每议题方案），写入指令中指定的位置，供后续逐议题生成待办执行与回写云效。",
  );

  const listLines: string[] = [`## 议题清单（共 ${input.issues.length} 项）`];
  input.issues.forEach((issue, index) => {
    const link = input.linksByIssue[issue.id] ?? "";
    const textPath = input.issueTextPathByIssue[issue.id] ?? "";
    listLines.push(`### ${index + 1}. ${issue.serialNumber} ${issue.subject}`);
    listLines.push(`- 类型：${categoryLabel(issue.categoryId)}`);
    if (issue.status) {
      listLines.push(`- 状态：${issue.status.displayName ?? issue.status.name ?? "未知"}`);
    }
    if (issue.assignedTo) {
      listLines.push(`- 负责人：${issue.assignedTo.name}`);
    }
    const priority = getYunxiaoPriority(issue);
    if (priority) {
      listLines.push(`- 优先级：${priority}`);
    }
    if (link) {
      listLines.push(`- 云效链接：${link}`);
    }
    if (textPath) {
      // 议题原文（含完整描述）落盘，正文不进 prompt；务必先读取再讨论。
      listLines.push(`- 议题原文（必须先读取）：${textPath}`);
    }
    listLines.push("");
  });
  pieces.push(listLines.join("\n").trim());

  const imageGroups = input.issues
    .map((issue) => ({ serial: issue.serialNumber, paths: input.imagePathsByIssue[issue.id] ?? [] }))
    .filter((group) => group.paths.length > 0);
  if (imageGroups.length > 0) {
    const lines = ["## 附件图片（按议题分组，用文件工具读取原图）"];
    for (const group of imageGroups) {
      lines.push(`### ${group.serial}`);
      lines.push(group.paths.join("\n"));
    }
    pieces.push(lines.join("\n"));
  }

  const notes = input.userNotes?.trim();
  if (notes) {
    pieces.push(
      `## 发起人补充（优先参考）\n以下是发起人手动补充的内容（背景描述、参考资料位置、已有修改方案等），优先于议题描述作为讨论基线：参考资料按位置自行读取；若包含已有修改方案，把它当作方案底稿在其上讨论完善，不要推倒重来；补充内容与你的分析结论冲突时，先向发起人确认再定稿。\n\n${notes}`,
    );
  }

  // 上游方案上下文紧跟议题清单：判依赖前必须先有可引用的编号与状态。
  const upstream = input.upstreamContext?.trim();
  if (upstream) {
    pieces.push(upstream);
  }

  if (input.instructions.trim()) {
    pieces.push(input.instructions.trim());
  }
  return pieces.filter((p) => p && p.trim()).join("\n\n");
}

/**
 * 追加子方案时注入讨论 prompt 的「上游方案上下文」（决策 B2'）。
 *
 * 两件事各司其职：**议题清单内联**（`dependsOn` 要写精确编号，不能靠模型猜），
 * **正文给绝对路径**（可能很长，让 agent 按需读取，与执行 prompt 同一套做法）。
 * 状态一律显式给出：门禁对「尚未生成待办」按 `missing`、`failed`/`cancelled`/`interrupted`
 * 按 `abnormal` 处理，agent 需要与门禁对同一份信息有共识。
 */
export function buildUpstreamPlanContext(input: {
  /** 祖先链：从直接父级到根（`planAncestorChain` 的返回值）。 */
  ancestors: readonly Plan[];
  /** 祖先方案 id → `plan.md` 绝对路径。 */
  planMdPathById: Readonly<Record<string, string>>;
  /** 承载议题的任务（全局，跨方案按编号索引）——用于判断上游议题是否已有任务。 */
  taskBySerial: ReadonlyMap<string, Task>;
}): string {
  if (input.ancestors.length === 0) return "";
  const pieces: string[] = [];

  pieces.push(
    "## 上游方案（追加来源）\n" +
      "本次讨论是往一个已定稿的主方案上**追加**议题：这批议题会被挂成一个**新增子方案**，主方案与其在跑任务零改动。" +
      "判定依赖时，除本批议题彼此之间，还要判断每个议题**是否依赖上游方案中的具体议题**：" +
      "只有当前置产出确实是本议题的输入时，才把那个议题编号写进本议题的 `dependsOn`；**没有依赖就不要写**" +
      "（不要整批依赖上游方案，也不要写「等整个上游方案完成」这类粗粒度表达）。" +
      "写之前先读上游方案的方案文档，确认产出与输入的关系。可引用的编号仅限下列上游方案议题，" +
      "其他方案 / 项目的编号会被丢弃。",
  );

  for (const ancestor of input.ancestors) {
    const lines: string[] = [`### ${planTitle(ancestor)}`];
    const mdPath = (input.planMdPathById[ancestor.id] ?? "").trim();
    if (mdPath) lines.push(`- 方案文档（先读取再判定依赖）：${mdPath}`);
    lines.push("", "议题清单：");
    for (const issue of ancestor.issues) {
      const task = input.taskBySerial.get(issue.serialNumber);
      const status = task ? taskStatusLabel(task.status) : "未生成待办";
      lines.push(`- ${issue.serialNumber} ${issue.subject}（${status}）`);
    }
    pieces.push(lines.join("\n"));
  }

  return pieces.join("\n\n");
}

/** deps 门禁口径下的任务状态文案（与 `isDependencySatisfied` / `isDependencyAbnormal` 同源）。 */
function taskStatusLabel(status: TaskStatus): string {
  if (status === "done") return "已完成";
  if (status === "failed") return "已失败";
  if (status === "cancelled") return "已取消";
  if (status === "interrupted") return "已中断";
  return "进行中";
}

/**
 * 讨论入口用：由「选中的父方案」组装注入讨论 prompt 的上游上下文。
 *
 * 从**选中的父方案**起算祖先链（含父方案自身）——此刻 draft 方案的 `parentPlanId`
 * 尚未落库，用方案 id 上溯拿不到自己。回归独立方案（未选父方案 / 父方案已不存在）返回空串。
 */
export function buildAppendUpstreamContext(input: {
  parentPlanId: string;
  plans: readonly Plan[];
  projectPath: string;
  tasks: readonly Task[];
}): string {
  const parentId = input.parentPlanId.trim();
  if (!parentId) return "";
  const parent = input.plans.find((plan) => plan.id === parentId);
  if (!parent) return "";
  const ancestors = [parent, ...planAncestorChain(parent.id, input.plans)];
  return buildUpstreamPlanContext({
    ancestors,
    planMdPathById: Object.fromEntries(
      ancestors.map((ancestor) => [ancestor.id, planMdPath(input.projectPath, ancestor.id)]),
    ),
    taskBySerial: buildTaskBySerial(input.tasks),
  });
}

/** 方案执行提示词：议题信息 + 方案统筹节 + 本议题节内联 + 全文路径 + 协作约束 + 后端执行指令。 */
export function buildPlanExecutionPrompt(input: {
  issue: { serialNumber: string; subject: string; categoryId?: string };
  link: string;
  planOverview: string;
  issueSection: string;
  planMdAbsolutePath: string;
  /** 本议题所属方案的上级方案文档绝对路径（追加子方案时才有）。 */
  upstreamPlanMdAbsolutePath?: string;
  imagePaths: string[];
  instructions: string;
}): string {
  const pieces: string[] = [];
  pieces.push(
    "你是「议题执行助手」。本议题属于一份已定稿的多议题联合方案：按方案执行本议题的改动，完成后产出价值评分与测试简报（落盘位置见指令），供「回写云效」直接生成两条评论（开发向 + 测试向）。",
  );

  const info = [
    `- 编号：${input.issue.serialNumber}`,
    `- 类型：${categoryLabel(input.issue.categoryId)}`,
    `- 标题：${input.issue.subject}`,
  ];
  pieces.push(`## 议题信息\n${info.join("\n")}`);

  if (input.planOverview.trim()) {
    pieces.push(`## 方案统筹（跨议题，已定稿）\n${input.planOverview.trim()}`);
  }
  if (input.issueSection.trim()) {
    pieces.push(`## 本议题方案（已定稿）\n${input.issueSection.trim()}`);
  }

  const link = input.link.trim();
  if (link) {
    pieces.push(`## 云效链接\n${link}`);
  }

  pieces.push(
    `## 方案全文\n方案文档绝对路径：${input.planMdAbsolutePath}\n（可读取全文了解跨议题统筹与其他议题节，但只执行本议题（${input.issue.serialNumber}）的改动，不要动其他议题的内容。）`,
  );

  // 追加子方案：子方案的统筹节可能引用上游方案议题，执行者需要能查证它是什么。
  const upstream = input.upstreamPlanMdAbsolutePath?.trim();
  if (upstream) {
    pieces.push(
      `## 上游方案全文\n上游方案文档绝对路径：${upstream}\n（本议题所属方案是它的追加子方案；本议题的硬依赖可能包含上游方案的议题。仅在本议题方案确有引用时按需读取，用于确认前置约定，不要执行上游方案的改动。）`,
    );
  }

  const tag = input.issue.serialNumber ? `#${input.issue.serialNumber}` : "";
  if (tag) {
    pieces.push(
      `## 协作约束\n所有 git commit message 必须包含议题编号 tag（${tag}，如 \`fix: 修复登录失效 ${tag}\`），云效按提交信息中的编号自动关联代码到议题。当前工作区可能还承载其他议题任务的改动，只提交本议题（${input.issue.serialNumber}）相关的改动，不要夹带其他议题的修改。`,
    );
  }

  if (input.imagePaths.length > 0) {
    pieces.push(`## 附件图片\n${input.imagePaths.join("\n")}`);
  }

  if (input.instructions.trim()) {
    pieces.push(input.instructions.trim());
  }
  return pieces.filter((p) => p && p.trim()).join("\n\n");
}

/**
 * 直接执行提示词（跳过讨论链路）：无方案文档，议题内容即 spec。
 * 议题信息 + 描述 + 附件图片 + 发起人补充 + 协作约束 + 后端直接执行指令。
 */
export function buildDirectExecutionPrompt(input: {
  issue: YunxiaoWorkitem;
  link: string;
  imagePaths: string[];
  /** 发起人手动补充（待办视图入口可填），原样拼进执行 prompt。 */
  userNotes?: string;
  instructions: string;
}): string {
  const pieces: string[] = [];
  pieces.push(
    "你是「议题执行助手」。本议题没有预先生成的方案文档，下方议题内容就是本次改动的 spec：按议题要求直接完成改动，并产出价值评分与测试简报（落盘位置见指令），供「回写云效」直接生成两条评论（开发向 + 测试向）。",
  );

  const info = [
    `- 编号：${input.issue.serialNumber}`,
    `- 类型：${categoryLabel(input.issue.categoryId)}`,
    `- 标题：${input.issue.subject}`,
  ];
  pieces.push(`## 议题信息\n${info.join("\n")}`);

  const description = normalizeIssueDescription(input.issue.description);
  if (description) {
    pieces.push(`## 议题描述\n${description}`);
  }

  const link = input.link.trim();
  if (link) {
    pieces.push(`## 云效链接\n${link}`);
  }

  const tag = input.issue.serialNumber ? `#${input.issue.serialNumber}` : "";
  if (tag) {
    pieces.push(
      `## 协作约束\n所有 git commit message 必须包含议题编号 tag（${tag}，如 \`fix: 修复登录失效 ${tag}\`），云效按提交信息中的编号自动关联代码到议题。当前工作区可能还承载其他议题任务的改动，只提交本议题（${input.issue.serialNumber}）相关的改动，不要夹带其他议题的修改。`,
    );
  }

  if (input.imagePaths.length > 0) {
    pieces.push(`## 附件图片（用文件工具读取原图）\n${input.imagePaths.join("\n")}`);
  }

  const notes = input.userNotes?.trim();
  if (notes) {
    pieces.push(
      `## 发起人补充（优先参考）\n以下是发起人手动补充的内容（背景描述、参考资料位置、已有修改方案等），优先于议题描述作为执行基线：参考资料按位置自行读取；若包含已有修改方案，把它当作底稿在其上完善，不要推倒重来；补充内容与议题描述冲突时，先向发起人确认再动手。\n\n${notes}`,
    );
  }

  if (input.instructions.trim()) {
    pieces.push(input.instructions.trim());
  }
  return pieces.filter((p) => p && p.trim()).join("\n\n");
}

/** 在方案文档中定位某议题的节：`## <编号> ` 起，到下一个 `## ` 标题或文末止。 */
export function extractPlanIssueSection(markdown: string, serialNumber: string): string | null {
  const serial = serialNumber.trim();
  if (!serial) return null;
  const lines = markdown.split(/\r?\n/);
  const isIssueHeading = (line: string) =>
    line.startsWith(`## ${serial} `) || line === `## ${serial}`;
  const start = lines.findIndex(isIssueHeading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  return section.length > 0 ? section : null;
}

/** 提取方案文档的统筹节：`## 统筹` 起，到下一个 `## ` 标题或文末止。 */
export function extractPlanOverview(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "## 统筹" || line.startsWith("## 统筹"));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * 生成待办 / 改绑时的统筹节校验：多议题方案的统筹节承载跨议题执行顺序与公共改动
 * 归属，缺失即阻断（missing = true）；单议题该节是仪式性内容（技能允许一句话带过，
 * 讨论模型常省略），缺失不阻断——overview 为空串时 buildPlanExecutionPrompt 会自然
 * 省略「方案统筹」节。
 */
export function extractPlanOverviewForIssues(
  markdown: string,
  issueCount: number,
): { overview: string; missing: boolean } {
  const overview = extractPlanOverview(markdown);
  return { overview, missing: !overview && issueCount > 1 };
}

/** 议题编号列表 → 方案任务名（如 "QHDK-123 等 3 项联合方案"）。 */
export function buildPlanTaskName(serialNumbers: string[]): string {
  const serials = serialNumbers.map((s) => s.trim()).filter(Boolean);
  if (serials.length === 0) return "联合方案讨论";
  const rest = serials.length - 1;
  return rest > 0 ? `方案讨论：${serials[0]} 等 ${serials.length} 项` : `方案讨论：${serials[0]}`;
}

/** 方案默认名（预览/确认页展示）：`QHDK-123 等 3 项联合方案`。 */
export function buildPlanDisplayName(serialNumbers: string[]): string {
  const serials = serialNumbers.map((s) => s.trim()).filter(Boolean);
  if (serials.length === 0) return "联合方案";
  const rest = serials.length - 1;
  return rest > 0 ? `${serials[0]} 等 ${serials.length} 项联合方案` : `${serials[0]} 联合方案`;
}
