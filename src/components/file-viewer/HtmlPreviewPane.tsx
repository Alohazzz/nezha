import { useMemo } from "react";
import { Info } from "lucide-react";
import { useI18n } from "../../i18n";

/**
 * srcdoc 预览下外部资源都不会加载，两类原因不同：
 * - 相对路径 / 根路径（`./x.png`、`/style.css`）：srcdoc 的 base URL 是 `about:srcdoc`，无从解析；
 * - 远程 CDN（`https://…`）：被应用自身 CSP 拦截（`img-src` / `script-src` 仅放行 'self' data: blob:）。
 *
 * 只有内联内容与 data: / blob: 资源可用。这里只做「是否需要提示」的启发式判断，
 * 误报的代价仅是多显示一行提示。
 */
const EXTERNAL_REF_RE = new RegExp(
  "<\\s*(?:script|img|iframe|source|video|audio|embed|track|input)\\b[^>]*\\bsrc\\s*=\\s*[\"'](?!data:|blob:|#)[^\"']+[\"']" +
    "|<\\s*link\\b[^>]*\\bhref\\s*=\\s*[\"'](?!data:|blob:|#)[^\"']+[\"']",
  "i",
);

export function HtmlPreviewPane({ html, fileName }: { html: string; fileName: string }) {
  const { t } = useI18n();
  const hasExternalRefs = useMemo(() => EXTERNAL_REF_RE.test(html), [html]);

  return (
    <div className="html-preview-pane">
      {hasExternalRefs && (
        <div className="html-preview-notice" role="note" title={t("file.htmlPreviewExternalHint")}>
          <Info size={12} />
          <span>{t("file.htmlPreviewExternalHint")}</span>
        </div>
      )}
      <iframe
        className="html-preview-frame"
        title={t("file.htmlPreview", { name: fileName })}
        sandbox="allow-scripts"
        srcDoc={html}
      />
    </div>
  );
}
