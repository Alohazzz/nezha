/**
 * 多议题联合方案（Plan）纯函数：路径推导、方案文档节提取、讨论/执行提示词组装。
 * 与后端约定保持一致：plan.md 节标题格式 `## <议题编号> <标题>`、测试小节
 * `### 影响范围与测试`（契约由 SkillHub `yunxiao-plan-discussion` 技能维护）。
 */
import type { YunxiaoWorkitem } from "../types";
import { normalizeIssueDescription, getYunxiaoPriority } from "./yunxiao";

/** 项目内方案目录：`<project>/.nezha/plans/<planId>/`。 */
export function planDirPath(projectPath: string, planId: string): string {
  return `${projectPath.replace(/[\\/]+$/, "")}/.nezha/plans/${planId}`;
}

/** 方案文档绝对路径。 */
export function planMdPath(projectPath: string, planId: string): string {
  return `${planDirPath(projectPath, planId)}/plan.md`;
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

/** 方案讨论提示词：议题清单（含描述）+ 附件图片 + 发起人补充 + 后端注入的联合讨论指令。 */
export function buildPlanDiscussionPrompt(input: {
  issues: YunxiaoWorkitem[];
  imagePathsByIssue: Record<string, string[]>;
  linksByIssue: Record<string, string>;
  /** 发起人在对话框手动补充的内容（背景描述/参考资料/已有修改方案等），可空。 */
  userNotes?: string;
  instructions: string;
}): string {
  const pieces: string[] = [];
  // 单议题与多议题共用 plan 链路，但框架口吻按议题数自适应，避免单议题被「跨议题统筹」带偏。
  pieces.push(
    input.issues.length === 1
      ? "你是「议题方案讨论助手」。请完整读懂下方议题，再按指定流程完成方案讨论。目标：产出该议题的方案文档（含修改方案与测试向内容），写入指令中指定的位置，供后续生成待办执行与回写云效。"
      : "你是「多云题联合方案讨论助手」。请先完整读懂下方全部议题，再按指定流程联合分析。目标：产出一份覆盖全部议题的统一方案文档（含跨议题统筹与每议题方案），写入指令中指定的位置，供后续逐议题生成待办执行与回写云效。",
  );

  const listLines: string[] = [`## 议题清单（共 ${input.issues.length} 项）`];
  input.issues.forEach((issue, index) => {
    const link = input.linksByIssue[issue.id] ?? "";
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
    const description = normalizeIssueDescription(issue.description);
    if (description) {
      listLines.push("", "描述：", description);
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

  if (input.instructions.trim()) {
    pieces.push(input.instructions.trim());
  }
  return pieces.filter((p) => p && p.trim()).join("\n\n");
}

/** 方案执行提示词：议题信息 + 方案统筹节 + 本议题节内联 + 全文路径 + 协作约束 + 后端执行指令。 */
export function buildPlanExecutionPrompt(input: {
  issue: { serialNumber: string; subject: string; categoryId?: string };
  link: string;
  planOverview: string;
  issueSection: string;
  planMdAbsolutePath: string;
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
