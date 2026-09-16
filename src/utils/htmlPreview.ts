/**
 * HTML 预览的资源内联层。
 *
 * 预览走 `iframe srcdoc`，其 base URL 是 `about:srcdoc`，页面里的 `./x.css`、
 * `../assets/q.js` 一律无从解析 —— 结果是「HTML 渲染出来了，但完全没有样式」。
 * 这里把项目内的相对资源读出来内联进文档（`<link>` → `<style>`、`<script src>` →
 * `<script>`、`<img src>` → data URL、CSS `url()` / `@import` → 内联），
 * 使被预览页面在不改 CSP、不加 Tauri feature 的前提下完整渲染。
 *
 * 本模块是纯函数：不做 I/O，资源内容由调用方通过 `lookup` 提供。
 * 输入输出均为字符串，便于单元测试。
 */

export type HtmlAssetKind = "stylesheet" | "script" | "image";

export type HtmlAssetRef = {
  /** 文档里出现的原始引用写法，仅用于日志与去重展示。 */
  ref: string;
  kind: HtmlAssetKind;
  /** 解析并归一化后的绝对路径（`/` 分隔，含盘符）。 */
  path: string;
};

export type HtmlAssetScan = {
  /** 需要读取并内联的本地资源（已按 kind + path 去重）。 */
  refs: HtmlAssetRef[];
  /** 指向远程的引用（CDN / http(s) / 协议相对）：受应用 CSP 限制，无法内联。 */
  external: string[];
};

/** 传入绝对路径，返回可内联的替换内容；返回 null 表示该资源不可用。 */
export type AssetLookup = (absolutePath: string) => string | null;

// ── 路径工具 ────────────────────────────────────────────────────────────────

/** 统一分隔符并归一化 `.` / `..` / 重复斜杠；超出根部的 `..` 直接判定为逃逸。 */
export function normalizePath(input: string): string | null {
  const unified = input.replace(/\\/g, "/");
  const drive = /^[a-zA-Z]:/.exec(unified)?.[0] ?? "";
  const rest = drive ? unified.slice(drive.length) : unified;
  const rooted = rest.startsWith("/");
  const segments: string[] = [];

  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (rooted || drive) {
        // 已经到根还继续向上：路径逃逸，拒绝。
        return null;
      } else {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  const prefix = drive ? `${drive}/` : rooted ? "/" : "";
  return prefix + segments.join("/");
}

/** 应用的引用形态：渲染前一律不做请求，能内联的只有项目内的本地文件。 */
function isNonLocalRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return true;
  // `#anchor`、`?query` 这类同文档引用不是外部资源。
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) return true;
  // 协议相对 `//cdn.example.com/x.js` 与任何 `scheme:` 都不是本地文件。
  if (trimmed.startsWith("//")) return true;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
}

/** 远程引用（会被应用 CSP 拦掉）与「同文档引用」分开，后者不需要任何提示。 */
function isRemoteRef(ref: string): boolean {
  const trimmed = ref.trim();
  if (trimmed.startsWith("//")) return true;
  return /^(https?|ws|wss|ftp):/i.test(trimmed);
}

function stripQueryAndHash(ref: string): string {
  const cut = ref.search(/[?#]/);
  return cut === -1 ? ref : ref.slice(0, cut);
}

function decodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref);
  } catch {
    // 非法百分号序列（或含 `%` 的本地文件名）原样使用。
    return ref;
  }
}

/**
 * 把文档里的引用解析成绝对路径。
 *
 * - `./x.png` / `../assets/a.css` 相对当前文件所在目录；
 * - `/assets/a.css` 在预览语义下没有可用的文件系统根，按项目根解释；
 * - 返回 null 表示不是可内联的本地资源（远程、data:、锚点、路径逃逸、缺上下文）。
 */
export function resolveAssetPath(
  ref: string,
  baseFilePath: string,
  projectRootPath?: string,
): string | null {
  if (isNonLocalRef(ref)) return null;

  // 先剥离 `?query` / `#hash`（未解码时切分才不会误伤 `%23`），再解码百分号转义。
  const clean = decodeRef(stripQueryAndHash(ref.trim()));
  if (!clean) return null;

  if (clean.startsWith("/")) {
    if (!projectRootPath) return null;
    const resolved = normalizePath(projectRootPath + "/" + clean);
    return resolved && isInsideProject(resolved, projectRootPath) ? resolved : null;
  }

  const baseDir = normalizePath(baseFilePath.replace(/[/\\][^/\\]*$/, ""));
  if (!baseDir) return null;

  const resolved = normalizePath(`${baseDir}/${clean}`);
  if (!resolved) return null;
  if (projectRootPath && !isInsideProject(resolved, projectRootPath)) return null;
  return resolved;
}

/** 归一化后判断路径是否落在项目内（Windows 盘符大小写不敏感，故统一小写比较）。 */
export function isInsideProject(targetPath: string, projectRootPath: string): boolean {
  const root = normalizePath(projectRootPath);
  if (!root) return false;
  const withSlash = root.endsWith("/") ? root : `${root}/`;
  return targetPath.toLowerCase().startsWith(withSlash.toLowerCase());
}

// ── HTML 扫描 ──────────────────────────────────────────────────────────────

/**
 * 逐个 token 遍历文档，把「原始文本元素」（`<script>` / `<style>`）与普通标签分开：
 * 普通标签走 `onTag`，`<style>` / `<script>` 整段走各自的回调。
 * 这样内联脚本 / 样式块里的 `<img src=…>` 字面量不会被误替换。
 */
function walkHtml(
  html: string,
  handlers: {
    onTag: (tag: string) => string;
    onStyleRegion: (openTag: string, css: string, closeTag: string) => string;
    onScriptRegion: (openTag: string, code: string, closeTag: string) => string;
  },
): string {
  let out = "";
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    // `<script>` / `<style>` 是 CDATA 类元素，内容不参与标签解析。
    const raw = /^<(script|style)\b/i.exec(html.slice(lt, lt + 8));
    if (raw) {
      const name = raw[1].toLowerCase();
      const contentStart = html.indexOf(">", lt);
      if (contentStart === -1) {
        out += html.slice(lt);
        break;
      }
      const closeStart = html.toLowerCase().indexOf(`</${name}`, contentStart + 1);
      if (closeStart === -1) {
        const openTag = html.slice(lt, contentStart + 1);
        const content = html.slice(contentStart + 1);
        out +=
          name === "style"
            ? handlers.onStyleRegion(openTag, content, "")
            : handlers.onScriptRegion(openTag, content, "");
        break;
      }
      const closeEnd = html.indexOf(">", closeStart);
      const stop = closeEnd === -1 ? html.length : closeEnd + 1;
      const openTag = html.slice(lt, contentStart + 1);
      const content = html.slice(contentStart + 1, closeStart);
      const closeTag = html.slice(closeStart, stop);
      out +=
        name === "style"
          ? handlers.onStyleRegion(openTag, content, closeTag)
          : handlers.onScriptRegion(openTag, content, closeTag);
      i = stop;
      continue;
    }

    // 普通标签：跳过引号内的 `>`。
    let cursor = lt + 1;
    let quote = "";
    while (cursor < html.length) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      cursor += 1;
    }
    const stop = Math.min(cursor + 1, html.length);
    out += handlers.onTag(html.slice(lt, stop));
    i = stop;
  }

  return out;
}

function tagName(tag: string): string {
  return /^<\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag)?.[1].toLowerCase() ?? "";
}

function readAttr(tag: string, name: string): { value: string; quote: string } | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
  if (!match) return null;
  const rawValue = match[1];
  const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : "";
  const value = quote ? rawValue.slice(1, -1) : rawValue;
  return { value, quote };
}

function setAttr(tag: string, name: string, value: string): string {
  const escaped = value.replace(/"/g, "&quot;");
  const re = new RegExp(`((?:^|\\s)${name}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, "i");
  if (re.test(tag)) return tag.replace(re, `$1"${escaped}"`);
  // 属性不存在时补在标签名之后，保证 `>` 仍在末尾。
  return tag.replace(/^<\s*([a-zA-Z][a-zA-Z0-9-]*)/, `<$1 ${name}="${escaped}"`);
}

/**
 * 带 src / poster 且需要按资源处理的元素。
 * 注意不含 `iframe`：其 src 是另一个文档，不能当图片读成 data URL。
 */
const SRC_TAG_ATTRS: Record<string, string[]> = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  embed: ["src"],
  track: ["src"],
};

function isStylesheetLink(tag: string): boolean {
  const rel = readAttr(tag, "rel")?.value ?? "";
  return rel.split(/\s+/).some((token) => token.toLowerCase() === "stylesheet");
}

export function scanHtmlAssets(
  html: string,
  baseFilePath: string,
  projectRootPath?: string,
): HtmlAssetScan {
  const refs = new Map<string, HtmlAssetRef>();
  const external = new Set<string>();

  const record = (rawRef: string, kind: HtmlAssetKind) => {
    if (isRemoteRef(rawRef)) {
      external.add(rawRef);
      return;
    }
    const path = resolveAssetPath(rawRef, baseFilePath, projectRootPath);
    if (path) refs.set(`${kind}:${path}`, { ref: rawRef, kind, path });
  };

  walkHtml(html, {
    onTag: (tag) => {
      const name = tagName(tag);
      if (name === "link") {
        const href = readAttr(tag, "href")?.value;
        if (href && isStylesheetLink(tag)) record(href, "stylesheet");
        return tag;
      }
      for (const attr of SRC_TAG_ATTRS[name] ?? []) {
        const value = readAttr(tag, attr)?.value;
        if (value) record(value, "image");
      }
      return tag;
    },
    onStyleRegion: (_openTag, css) => {
      const scanned = scanCssAssets(css, baseFilePath, projectRootPath);
      for (const ref of scanned.refs) refs.set(`${ref.kind}:${ref.path}`, ref);
      for (const remote of scanned.external) external.add(remote);
      return "";
    },
    onScriptRegion: (openTag, _code, closeTag) => {
      // 只从开始标签读 src：脚本正文里出现 `src="…"` 字面量（模板字符串）时，
      // 在整段上匹配会把正文内容当成真实引用。
      const src = readAttr(openTag, "src")?.value;
      if (src) record(src, "script");
      return openTag + _code + closeTag;
    },
  });

  return { refs: [...refs.values()], external: [...external] };
}

// ── CSS ────────────────────────────────────────────────────────────────────

const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]+))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^)'"\s;]+))\s*\)?\s*([^;]*);/gi;

function cssString(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("data:")) return null;
  return trimmed;
}

export function scanCssAssets(
  css: string,
  cssFilePath: string,
  projectRootPath?: string,
): HtmlAssetScan {
  const refs = new Map<string, HtmlAssetRef>();
  const external = new Set<string>();

  const record = (rawRef: string, kind: HtmlAssetKind) => {
    if (isRemoteRef(rawRef)) {
      external.add(rawRef);
      return;
    }
    const path = resolveAssetPath(rawRef, cssFilePath, projectRootPath);
    if (path) refs.set(`${kind}:${path}`, { ref: rawRef, kind, path });
  };

  for (const match of css.matchAll(CSS_IMPORT_RE)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (ref) record(ref, "stylesheet");
  }
  for (const match of css.matchAll(CSS_URL_RE)) {
    const ref = match[1] ?? match[2] ?? match[3];
    if (ref && cssString(ref)) record(ref, "image");
  }

  return { refs: [...refs.values()], external: [...external] };
}

/** 内联 CSS 里的 `url()` 与 `@import`；未命中 lookup 的本地引用记入 `unresolved`。 */
export function renderCssWithInlineAssets(
  css: string,
  cssFilePath: string,
  lookup: AssetLookup,
  projectRootPath?: string,
): { css: string; unresolved: string[] } {
  const unresolved: string[] = [];

  const replaceRef = (ref: string, wrap: (value: string) => string | null) => {
    const path = resolveAssetPath(ref, cssFilePath, projectRootPath);
    if (!path) return null;
    const value = lookup(path);
    if (value === null) {
      unresolved.push(ref);
      return null;
    }
    const wrapped = wrap(value);
    if (wrapped === null) {
      unresolved.push(ref);
      return null;
    }
    return wrapped;
  };

  const withImports = css.replace(CSS_IMPORT_RE, (whole, dq, sq, bare) => {
    const ref = dq ?? sq ?? bare;
    if (!ref) return whole;
    const replaced = replaceRef(ref, (value) =>
      // 内联后不能再出现结束标签，否则文档结构被截断。
      /<\/style/i.test(value) ? null : value,
    );
    return replaced ?? whole;
  });

  const withUrls = withImports.replace(CSS_URL_RE, (whole, dq, sq, bare) => {
    const ref = dq ?? sq ?? bare;
    if (!ref || !cssString(ref)) return whole;
    const replaced = replaceRef(ref, (value) => `url("${value}")`);
    return replaced ?? whole;
  });

  return { css: withUrls, unresolved };
}

// ── HTML 渲染 ──────────────────────────────────────────────────────────────

/**
 * 把可内联的本地资源替换进文档。未提供的本地资源原样保留并记入 `unresolved`，
 * 使预览「能渲染多少渲染多少」，而不是整页失败。
 */
export function renderHtmlWithInlineAssets(
  html: string,
  baseFilePath: string,
  lookup: AssetLookup,
  projectRootPath?: string,
): { html: string; unresolved: string[] } {
  const unresolved: string[] = [];

  const inlineLocal = (ref: string, wrap: (value: string) => string | null): string | null => {
    const path = resolveAssetPath(ref, baseFilePath, projectRootPath);
    if (!path) return null;
    const value = lookup(path);
    // 读不到（缺失 / 超限 / 项目外）与「读到了但拒绝内联」（正文含结束标签）
    // 对用户是同一种结果：这个引用没能加载。
    if (value === null) {
      unresolved.push(ref);
      return null;
    }
    const wrapped = wrap(value);
    if (wrapped === null) {
      unresolved.push(ref);
      return null;
    }
    return wrapped;
  };

  const rendered = walkHtml(html, {
    onTag: (tag) => {
      const name = tagName(tag);

      if (name === "link") {
        const href = readAttr(tag, "href")?.value;
        if (!href || !isStylesheetLink(tag)) return tag;
        const replaced = inlineLocal(href, (css) =>
          // 样式文本里出现 `</style` 会让内联样式提前闭合，宁可保留外链。
          /<\/style/i.test(css) ? null : `<style data-nezha-inlined-from="${href}">\n${css}\n</style>`,
        );
        return replaced ?? tag;
      }

      let next = tag;
      for (const attr of SRC_TAG_ATTRS[name] ?? []) {
        const current = readAttr(next, attr)?.value;
        if (!current) continue;
        const replaced = inlineLocal(current, (dataUrl) =>
          setAttr(next, attr, dataUrl),
        );
        if (replaced !== null) next = replaced;
      }
      return next;
    },
    onStyleRegion: (openTag, css, closeTag) => {
      const inlined = renderCssWithInlineAssets(css, baseFilePath, lookup, projectRootPath);
      unresolved.push(...inlined.unresolved);
      return openTag + inlined.css + closeTag;
    },
    onScriptRegion: (openTag, code, closeTag) => {
      const src = readAttr(openTag, "src")?.value;
      if (!src) return openTag + code + closeTag;
      const replaced = inlineLocal(src, (script) =>
        // 脚本正文出现 `</script` 时无法内联（会把文档截断），保留外链。
        /<\/script/i.test(script) ? null : `<script>\n${script}\n</script>`,
      );
      return replaced ?? openTag + code + closeTag;
    },
  });

  return { html: rendered, unresolved };
}
