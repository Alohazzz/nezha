import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../../i18n";
import {
  renderCssWithInlineAssets,
  renderHtmlWithInlineAssets,
  scanCssAssets,
  scanHtmlAssets,
  type AssetLookup,
  type HtmlAssetRef,
  type HtmlAssetScan,
} from "../../utils/htmlPreview";

/**
 * srcdoc 的 base URL 是 `about:srcdoc`，页面里的相对路径无处解析；远程 CDN 又被
 * 应用自身 CSP 拦下（`img-src` / `script-src` 只放行 'self' data: blob:）。
 * 所以先把项目内的相对资源读出来内联进文档（见 utils/htmlPreview.ts），
 * 剩下的 CDN 引用才需要提示用户。
 *
 * 没有 filePath / projectPath 时（老调用方 / 单测）退回纯启发式判断：只要文档里
 * 出现任何非内联引用就提示，且不做任何读取。
 */
const EXTERNAL_REF_RE = new RegExp(
  "<\\s*(?:script|img|iframe|source|video|audio|embed|track|input)\\b[^>]*\\bsrc\\s*=\\s*[\"'](?!data:|blob:|#)[^\"']+[\"']" +
    "|<\\s*link\\b[^>]*\\bhref\\s*=\\s*[\"'](?!data:|blob:|#)[^\"']+[\"']",
  "i",
);

/** 单次预览内联的资源总量上限，避免超大文档把读取放大成可观的内存占用。 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
/** `@import` 递归深度上限，同时防循环引用。 */
const MAX_IMPORT_DEPTH = 4;

/**
 * 按需读取本地资源，返回「绝对路径 → 可直接内联的文本 / data URL」的查表函数。
 * 读取一律走既有命令，因此路径仍然经过 Rust 侧的 validate_path_within 校验。
 */
function createAssetLoader(projectPath: string) {
  const cache = new Map<string, string | null>();
  const unresolved = new Set<string>();
  let remaining = MAX_INLINE_BYTES;

  const readText = async (path: string): Promise<string | null> => {
    try {
      return await invoke<string>("read_file_content", { path, projectPath });
    } catch {
      // 文件缺失、超出 2 MB 上限或位于项目外：调用方按「未加载」计数。
      return null;
    }
  };

  const readImage = async (path: string): Promise<string | null> => {
    try {
      const preview = await invoke<{ dataUrl: string }>("read_image_preview", {
        path,
        projectPath,
      });
      return preview.dataUrl;
    } catch {
      return null;
    }
  };

  const spend = (bytes: number): boolean => {
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  };

  const loadStylesheet = async (path: string, depth: number): Promise<string | null> => {
    if (depth > MAX_IMPORT_DEPTH) return null;
    const css = await readText(path);
    if (css === null || !spend(css.length)) return null;

    // 先递归把 @import / url() 指向的资源都读进来，再同步替换 —— 渲染函数保持纯同步。
    const { refs } = scanCssAssets(css, path, projectPath);
    await Promise.all(refs.map((ref) => loadRef(ref, depth + 1)));

    return renderCssWithInlineAssets(
      css,
      path,
      (target) => cache.get(target) ?? null,
      projectPath,
    ).css;
  };

  const loadRef = async (ref: HtmlAssetRef, depth: number): Promise<void> => {
    if (cache.has(ref.path)) return;
    const value =
      ref.kind === "image"
        ? await readImage(ref.path)
        : ref.kind === "script"
          ? await readText(ref.path)
          : await loadStylesheet(ref.path, depth);
    cache.set(ref.path, value);
    if (value === null) unresolved.add(ref.ref);
  };

  return {
    async load(refs: HtmlAssetRef[]): Promise<{ lookup: AssetLookup; unresolved: string[] }> {
      await Promise.all(refs.map((ref) => loadRef(ref, 0)));
      return { lookup: (path) => cache.get(path) ?? null, unresolved: [...unresolved] };
    },
  };
}

export function HtmlPreviewPane({
  html,
  fileName,
  filePath,
  projectPath,
}: {
  html: string;
  fileName: string;
  /** 被预览文件的绝对路径；缺省则不内联资源。 */
  filePath?: string;
  /** 项目根，用于校验与解释根路径引用。 */
  projectPath?: string;
}) {
  const { t } = useI18n();

  const plan = useMemo<HtmlAssetScan | null>(() => {
    if (!filePath || !projectPath) return null;
    return scanHtmlAssets(html, filePath, projectPath);
  }, [html, filePath, projectPath]);

  // 内联结果与产生它的 plan 绑定：切换文件时 plan 变化，旧结果自然失效，
  // 不会先渲染上一个文件的内容再被替换。
  const [loaded, setLoaded] = useState<{
    plan: HtmlAssetScan;
    srcDoc: string;
    missing: string[];
  } | null>(null);

  const legacyHint = useMemo(
    () => (plan === null ? EXTERNAL_REF_RE.test(html) : false),
    [plan, html],
  );

  const needsAssets = plan !== null && plan.refs.length > 0;
  const ready = !needsAssets || loaded?.plan === plan;

  useEffect(() => {
    if (!plan || !filePath || !projectPath || plan.refs.length === 0) return;

    let cancelled = false;
    void (async () => {
      const { lookup, unresolved } = await createAssetLoader(projectPath).load(plan.refs);
      if (cancelled) return;
      const rendered = renderHtmlWithInlineAssets(html, filePath, lookup, projectPath);
      setLoaded({
        plan,
        srcDoc: rendered.html,
        missing: [...new Set([...unresolved, ...rendered.unresolved])],
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [plan, html, filePath, projectPath]);

  // `missing` 必须来自当前文件的加载结果：切换文件时 `loaded` 仍可能持有上一次的
  // 结果（尤其是新文件无需内联时 `ready` 立即为 true），不能直接用。
  const missing = loaded && loaded.plan === plan ? loaded.missing : [];
  const notices: string[] = [];
  if (missing.length > 0) {
    notices.push(t("file.htmlPreviewMissingAssetsHint", { count: missing.length }));
  }
  if (legacyHint || (plan !== null && plan.external.length > 0)) {
    notices.push(t("file.htmlPreviewExternalHint"));
  }

  return (
    <div className="html-preview-pane">
      {notices.map((notice) => (
        <div className="html-preview-notice" role="note" title={notice} key={notice}>
          <Info size={12} />
          <span>{notice}</span>
        </div>
      ))}
      {ready ? (
        <iframe
          className="html-preview-frame"
          title={t("file.htmlPreview", { name: fileName })}
          sandbox="allow-scripts"
          srcDoc={needsAssets ? (loaded?.srcDoc ?? html) : html}
        />
      ) : (
        <div className="html-preview-loading">{t("common.loading")}</div>
      )}
    </div>
  );
}
