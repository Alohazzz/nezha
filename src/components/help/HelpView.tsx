import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import type { ThemeVariant } from "../../types";
import { useI18n } from "../../i18n";

type HelpDoc = {
  id: "manual" | "yunxiao";
  file: string;
  labelKey: string;
};

const HELP_DOCS: HelpDoc[] = [
  { id: "manual", file: "operation-manual.html", labelKey: "help.doc.manual" },
  { id: "yunxiao", file: "yunxiao-launch-modes.html", labelKey: "help.doc.yunxiao" },
];

/**
 * 首页帮助中心：以 iframe 内嵌 docs/ 下同步到 public/help/ 的静态 HTML 文档。
 *
 * 文档本身支持 `?embed=1`（隐藏自身页头、压缩留白）与 `?theme=` 初始主题；
 * 主题切换走 postMessage 而不是改 src——改 src 会重载 iframe 并丢掉阅读位置。
 */
export function HelpView({ themeVariant }: { themeVariant: ThemeVariant }) {
  const { t } = useI18n();
  const [docId, setDocId] = useState<HelpDoc["id"]>("manual");
  const frameRef = useRef<HTMLIFrameElement>(null);

  const isDark = themeVariant === "dark" || themeVariant === "midnight";
  const theme = isDark ? "dark" : "light";
  // 只在 iframe 首次加载时作为初始主题；后续主题切换经 postMessage 下发（改 src 会重载并丢阅读位置）。
  const themeAtLoad = useRef(theme);
  themeAtLoad.current = theme;

  const activeDoc = HELP_DOCS.find((d) => d.id === docId) ?? HELP_DOCS[0];
  const src = useMemo(
    () => `help/${activeDoc.file}?embed=1&theme=${themeAtLoad.current}`,
    [activeDoc.file],
  );

  const pushTheme = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: "nezha-help-theme", theme },
      "*",
    );
  }, [theme]);

  useEffect(() => {
    pushTheme();
  }, [pushTheme, docId]);

  // 文档内跨文档链接（如「操作手册」↔「云效议题详解」）交由宿主切 tab，避免 iframe 内部跳走。
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; file?: string } | null;
      if (!data || data.type !== "nezha-help-open" || typeof data.file !== "string") return;
      const target = HELP_DOCS.find((d) => d.file === data.file);
      if (target) setDocId(target.id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div className="help-view">
      <div className="help-view-head">
        <div className="help-view-title">
          <BookOpen size={15} strokeWidth={2} />
          {t("help.title")}
        </div>
        <div className="help-view-tabs" role="tablist" aria-label={t("help.title")}>
          {HELP_DOCS.map((doc) => (
            <button
              key={doc.id}
              type="button"
              role="tab"
              aria-selected={doc.id === docId}
              data-active={doc.id === docId}
              className="help-view-tab"
              onClick={() => setDocId(doc.id)}
            >
              {t(doc.labelKey)}
            </button>
          ))}
        </div>
      </div>
      <iframe
        ref={frameRef}
        key={activeDoc.id}
        className="help-view-frame"
        src={src}
        title={t("help.title")}
        onLoad={pushTheme}
      />
    </div>
  );
}
