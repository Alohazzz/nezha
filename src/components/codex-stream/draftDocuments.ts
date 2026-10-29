// 会话正文链接的识别与解析。可打开的目标分三类：
//   - 外链（http/https/mailto）→ 系统浏览器；
//   - file:// 本地文件 → 解码成本地路径后交系统默认应用（.html 即默认浏览器）；
//   - 项目内相对路径 → 右列 FileViewer 打开（read_file_content 服务端校验
//     「必须在项目根内」，沙箱不会逃逸）。
// 其中沉淀契约产物（drafts.rs::ALLOWED_DRAFT_FILES 白名单：discussion.md /
// knowledge.json / backfill-issue.json）有额外的「裸文件名回落」语义：agent
// 常不带路径地引用它们，实际位置固定在 .nezha/drafts/<taskId>/ 下。
// 锚点、未知协议（javascript:/vscode: 等）、绝对路径（盘符 / ~）不支持打开。

/** drafts.rs::ALLOWED_DRAFT_FILES 同款白名单。 */
export const DRAFT_DOCUMENT_NAMES = [
  "discussion.md",
  "knowledge.json",
  "backfill-issue.json",
] as const;

export type DraftDocumentName = (typeof DRAFT_DOCUMENT_NAMES)[number];

export type MarkdownLinkKind =
  /** 外部链接，点击走系统浏览器。 */
  | "external"
  /** file:// 本地文件，点击解码成本地路径后交系统默认应用打开。 */
  | "localFile"
  /** 项目内相对路径（含沉淀文档），点击在应用内打开。 */
  | "projectPath"
  /** 锚点 / 未知协议 / 绝对路径，不支持打开。 */
  | "unsupported";

export type MarkdownLinkTarget =
  | { kind: "external"; href: string }
  | { kind: "localFile"; /** 解码后的本地绝对路径（Windows 盘符已还原为反斜杠形态）。 */ path: string }
  | { kind: "projectPath"; href: string; /** 路径 basename，用作 FileViewer tab 名。 */ fileName: string }
  | { kind: "unsupported" };

export function isDraftDocumentName(name: string): name is DraftDocumentName {
  return (DRAFT_DOCUMENT_NAMES as readonly string[]).includes(name);
}

/** 对 <a href> 分类。
 *  agent 生成的链接常见「绝对路径 + :line 行号后缀」形态（H:/…/a.ts:1，VS Code
 *  风格）——行号在这里剥掉；绝对路径若落在项目根/worktree 内会被 resolve 成
 *  相对路径（真正的沙箱边界由 read_file_content 的「项目根内」校验兜住）。 */
export function classifyMarkdownLink(rawHref: string): MarkdownLinkTarget {
  const href = rawHref.trim();
  if (!href || href.startsWith("#")) return { kind: "unsupported" };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", href };
  if (/^file:\/\//i.test(href)) return classifyFileUrl(href);
  // 多字符 scheme（javascript: / vscode: …）一律不进应用内打开；
  // 单字母 `H:` 是 Windows 盘符（agent 引用项目文件的常态），放行到 resolve 阶段。
  // scheme 首段写成 {2,} 正是为了把单字母盘符排除在外。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) && !/^[a-zA-Z]:/.test(href)) {
    return { kind: "unsupported" };
  }
  if (href.startsWith("~")) return { kind: "unsupported" };

  // marked 渲染链接时会对目标做 percent-encode（中文文件名 → %E5%BC%80…），
  // 点击委托读的是 DOM 属性原值，这里必须先解码再交路径解析；畸形编码
  //（孤立 % / 截断的 UTF-8 序列）回退原文。
  const withoutLine = href.replace(/:\d+$/, "");
  let decoded = withoutLine;
  try {
    decoded = decodeURIComponent(withoutLine);
  } catch {
    // keep raw href
  }
  const segments = decoded.split(/[\\/]/).filter(Boolean);
  const fileName = segments[segments.length - 1] ?? "";
  if (!fileName) return { kind: "unsupported" };
  return { kind: "projectPath", href: decoded, fileName };
}

/** file:// URL → 本地绝对路径（percent 解码 + Windows 盘符/分隔符还原）。
 *  非 localhost 的主机名（file://server/share 的 UNC 形态）一律不开——agent
 *  产出的是本机文件链接，UNC 路径交给系统解析属于越权面。解析失败返回
 *  unsupported。 */
function classifyFileUrl(href: string): MarkdownLinkTarget {
  try {
    const url = new URL(href);
    if (url.protocol.toLowerCase() !== "file:") return { kind: "unsupported" };
    if (url.hostname && url.hostname.toLowerCase() !== "localhost") return { kind: "unsupported" };
    if (!url.pathname || url.pathname.endsWith("/")) return { kind: "unsupported" };
    let path = decodeURIComponent(url.pathname);
    // Windows 形如 /C:/Users/... → C:\Users\...；Unix 保留开头的 /。
    const winMatch = /^\/([a-zA-Z]:)(.*)$/.exec(path);
    if (winMatch) {
      path = `${winMatch[1]}${winMatch[2]}`.replace(/\//g, "\\");
    }
    return path ? { kind: "localFile", path } : { kind: "unsupported" };
  } catch {
    return { kind: "unsupported" };
  }
}

/**
 * 把正文里的裸文件名（非 Markdown 链接语法）标记成可点击链接。
 * 只转沉淀白名单文件名（discussion.md / knowledge.json 等），且要求边界
 * 是非路径字符，避免把 `foo/discussion.md.bak`、`not-discussion.md` 这类
 * 误转。`>` 前缀同样跳过——那上一个字符是已渲染链接的锚文本，再包一层
 * 会产生非法嵌套 <a>，点击委托会命中内层假 href。返回原始文本（未命中）
 * 或替换后的 HTML 片段。
 */
export function linkifyBareDraftNames(text: string): string | null {
  const names = DRAFT_DOCUMENT_NAMES.join("|");
  const pattern = new RegExp(`(^|[^\\w./\\\\>-])(${names})(?![\\w.>])`, "gi");
  let matched = false;
  const html = text.replace(pattern, (_all, lead: string, name: string) => {
    matched = true;
    return `${lead}<a href="${name}" data-draft-link="1">${name}</a>`;
  });
  return matched ? html : null;
}

export interface DraftDocumentPathInput {
  /** 链接目标（项目内相对路径，或落在项目内的绝对路径）。 */
  href: string;
  /** 项目根（绝对路径）。 */
  projectPath: string;
  /** 任务 worktree 根（绝对路径；worktree 已丢弃时为 null）。 */
  worktreePath: string | null;
  /** 任务 id（沉淀白名单裸文件名按 .nezha/drafts/<taskId>/ 回落）。 */
  taskId: string;
}

/** 把 href 归一成待拼接的相对形式，并报告它锚定在哪个 base 上：
 *  相对路径锚定 null（语义上「相对所属仓库」，项目根/worktree 都试）；
 *  绝对路径剥掉 projectPath / worktreePath 前缀后锚定对应 base，项目外返回 null。 */
function resolveRelative(
  href: string,
  projectPath: string,
  worktreePath: string | null,
): { rel: string; anchoredTo: string | null } | null {
  const parts = (base: string) => base.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  const segments = href.split(/[\\/]/).filter(Boolean);
  if (segments.length === 0) return null;
  // 绝对路径判定：盘符开头（H:/…）或以 / 开头。
  if (/^[a-zA-Z]:/.test(href) || href.startsWith("/")) {
    for (const base of [projectPath, worktreePath]) {
      if (!base) continue;
      const baseParts = parts(base);
      let i = 0;
      while (i < baseParts.length && segments[i]?.toLowerCase() === baseParts[i].toLowerCase()) i += 1;
      if (i === baseParts.length) {
        return { rel: segments.slice(i).join("/"), anchoredTo: base };
      }
    }
    return null;
  }
  return { rel: segments.filter((seg) => seg !== ".").join("/"), anchoredTo: null };
}

/**
 * 链接目标 → 待读的绝对路径候选（按序尝试）。
 * 相对路径按项目根、worktree 各解析一次；项目内绝对路径剥掉对应前缀后同上
 * （项目外的绝对路径返回空）；沉淀白名单的裸文件名额外回落到
 * `.nezha/drafts/<taskId>/<name>`（沉淀契约的固定位置），且优先于项目根同名
 * 文件尝试。
 */
export function draftDocumentPathCandidates(input: DraftDocumentPathInput): string[] {
  const { href, projectPath, worktreePath, taskId } = input;
  const join = (base: string, rel: string) => `${base.replace(/[\\/]+$/, "")}/${rel.replace(/^[\\/]+/, "")}`;
  const segments = href.trim().split(/[\\/]/).filter(Boolean);
  const bareName = segments.length === 1 ? (segments[0] ?? "") : "";
  const isBareDraft = isDraftDocumentName(bareName.toLowerCase());
  const resolved = resolveRelative(href, projectPath, worktreePath);
  if (resolved === null) return [];
  const { rel, anchoredTo } = resolved;

  const rels = isBareDraft && !rel.includes("/") ? [`.nezha/drafts/${taskId}/${rel}`, rel] : [rel];
  // 相对路径「相对所属仓库」语义不明，项目根/worktree 都试；绝对路径已锚定
  // 具体位置，剥前缀后只在那个 base 下解析。
  const bases =
    anchoredTo !== null
      ? [anchoredTo]
      : worktreePath && worktreePath !== projectPath
        ? [projectPath, worktreePath]
        : [projectPath];

  const out: string[] = [];
  for (const base of bases) {
    for (const r of rels) {
      const candidate = join(base, r);
      if (!out.includes(candidate)) out.push(candidate);
    }
  }
  return out;
}
