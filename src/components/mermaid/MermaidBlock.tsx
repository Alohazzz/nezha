import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Maximize2, Loader2 } from "lucide-react";
import { useCodexThemeVariant } from "../codex-stream/useCodexThemeVariant";
import { useI18n } from "../../i18n";

// 对照 ZCode packages/ui/src/components/ai-elements/mermaid-block.tsx 的关键防线，
// 全部保留：
// 1. 全局串行渲染队列——mermaid.render 并发会相互踩踏内部状态；
// 2. CSS 变量 → canvas 采样归一化——mermaid 底层 khroma 只认 rgb()/rgba()，
//    直接把 var(--x) 或 color-mix() 喂给它会渲染出黑块；
// 3. 渲染失败回退纯文本代码块（流式输出中语法未写完是常态，不弹错误面板）；
// 4. StrictMode 双挂载安全：useEffect cleanup 里置 cancelled，过期结果不落 state。
//
// mermaid 通过动态 import() 加载（同 shiki 先例）：它带布局引擎与字体解析，
// 静态打包会让主包膨胀数 MB。

export interface MermaidBlockProps {
  code: string;
  /** 点击放大按钮回调；不传则不显示放大入口。 */
  onOpenPreview?: () => void;
  /** 渲染成功后把 SVG 字符串上抛（供放大预览复用）；未渲染成功时为 null。 */
  onPreviewSvgChange?: (svg: string | null) => void;
}

type MermaidRenderState =
  | { status: "loading" }
  | { status: "ready"; svg: string }
  | { status: "plaintext" };

let mermaidModulePromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  mermaidModulePromise ??= import("mermaid").then((m) => m.default);
  return mermaidModulePromise;
}

// 全局串行队列：mermaid 12 的 render 官方文档声明并发调用会排队，但显式队列
// 能保证「取色 → initialize → render」这三步作为整体不被另一个主题的渲染插队。
let mermaidRenderQueue: Promise<unknown> = Promise.resolve();

function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// FNV-1a 哈希：从代码内容生成稳定、合法的 SVG 渲染 id 前缀。
function hashMermaidCode(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const MERMAID_COLOR_CANVAS_SENTINEL = "#010203";

const canCreateDomElements =
  typeof document !== "undefined" && typeof document.createElement === "function";
const mermaidColorResolverEl: HTMLSpanElement | null = canCreateDomElements
  ? document.createElement("span")
  : null;
const mermaidColorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (!canCreateDomElements) return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx) ctx.globalCompositeOperation = "copy";
  return ctx;
})();

// 主题 CSS 变量 → mermaid 可解析的传统 rgb()/rgba()。先用探针 span 让浏览器
// 解析 var()，再用 1×1 canvas 采样成具体色值；canvas 不支持的格式会停在哨兵
// 色，此时回退调用方给的安全色。
function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  if (!raw || !mermaidColorResolverEl || !mermaidColorNormalizeCtx || !document.body) {
    return raw || fallback;
  }
  try {
    document.body.appendChild(mermaidColorResolverEl);
    mermaidColorResolverEl.style.color = "";
    mermaidColorResolverEl.style.color = raw;
    const resolved = getComputedStyle(mermaidColorResolverEl).color;
    if (!resolved) return fallback;
    mermaidColorNormalizeCtx.clearRect(0, 0, 1, 1);
    mermaidColorNormalizeCtx.fillStyle = MERMAID_COLOR_CANVAS_SENTINEL;
    const sentinelFillStyle = mermaidColorNormalizeCtx.fillStyle;
    mermaidColorNormalizeCtx.fillStyle = resolved;
    if (mermaidColorNormalizeCtx.fillStyle === sentinelFillStyle) return fallback;
    mermaidColorNormalizeCtx.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 255] = mermaidColorNormalizeCtx.getImageData(0, 0, 1, 1).data;
    const roundedAlpha = +(a / 255).toFixed(3);
    return roundedAlpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${roundedAlpha})`;
  } catch {
    return fallback;
  } finally {
    mermaidColorResolverEl.remove();
  }
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === "undefined" || !document.body) return fallback;
  const probe = document.createElement("span");
  probe.style.color = `var(${variableName})`;
  probe.style.pointerEvents = "none";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return normalizeCssColorForMermaid(color, fallback);
}

interface MermaidThemeColors {
  background: string;
  surface: string;
  accent: string;
  text: string;
  subtleText: string;
  border: string;
}

// 每次渲染前从当前 DOM 取主题色： nezha 的六套主题（light / eyecare / dark /
// midnight / zinc / claude）全部是 html class 切换的 CSS 自定义属性，这里不做
// 静态映射，任何主题/新主题自动适配。
function resolveMermaidThemeColors(): MermaidThemeColors {
  return {
    background: resolveCssColor("--bg-subtle", "#f4f4f5"),
    surface: resolveCssColor("--bg-card", "#ffffff"),
    accent: resolveCssColor("--accent-subtle", "#f0f9ff"),
    text: resolveCssColor("--text-primary", "#27272a"),
    subtleText: resolveCssColor("--text-secondary", "#52525b"),
    border: resolveCssColor("--border-dim", "#d4d4d8"),
  };
}

function createMermaidConfig(colors: MermaidThemeColors, dark: boolean): import("mermaid").MermaidConfig {
  return {
    // securityLevel: "strict" 下 mermaid 内置 DOMPurify 消毒 SVG 输出。
    securityLevel: "strict",
    startOnLoad: false,
    suppressErrorRendering: true,
    fontFamily: "var(--font-ui, sans-serif)",
    theme: "base",
    themeVariables: {
      darkMode: dark,
      background: colors.background,
      mainBkg: colors.surface,
      textColor: colors.text,
      lineColor: colors.subtleText,
      primaryColor: colors.surface,
      primaryTextColor: colors.text,
      primaryBorderColor: colors.border,
      secondaryColor: colors.accent,
      secondaryTextColor: colors.text,
      secondaryBorderColor: colors.border,
      tertiaryColor: colors.background,
      tertiaryTextColor: colors.text,
      tertiaryBorderColor: colors.border,
      nodeBorder: colors.border,
      clusterBkg: colors.background,
      clusterBorder: colors.border,
      edgeLabelBackground: colors.surface,
      noteBkgColor: colors.accent,
      noteTextColor: colors.text,
      noteBorderColor: colors.border,
      actorBkg: colors.surface,
      actorBorder: colors.border,
      actorTextColor: colors.text,
      signalColor: colors.subtleText,
      signalTextColor: colors.text,
      labelBoxBkgColor: colors.surface,
      labelBoxBorderColor: colors.border,
      labelTextColor: colors.text,
      loopTextColor: colors.text,
      /* cSpell: disable-next-line */
      activationBkgColor: colors.accent,
      sequenceNumberColor: colors.surface,
      pie1: colors.surface,
      pie2: colors.accent,
      pie3: colors.border,
      pieTitleTextColor: colors.text,
      pieSectionTextColor: colors.text,
      /* cSpell: disable-next-line */
      ganttTextColor: colors.text,
    },
  };
}

export function MermaidBlock({ code, onOpenPreview, onPreviewSvgChange }: MermaidBlockProps) {
  const { t } = useI18n();
  const themeVariant = useCodexThemeVariant();
  const reactIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const trimmedCode = code.trim();
  const [renderState, setRenderState] = useState<MermaidRenderState>({ status: "loading" });
  // 回调走 ref：消费方传内联箭头函数时不会把 effect 打成重渲染循环。
  const onPreviewSvgChangeRef = useRef(onPreviewSvgChange);
  useEffect(() => {
    onPreviewSvgChangeRef.current = onPreviewSvgChange;
  }, [onPreviewSvgChange]);

  // 主题 class 变化 → useSyncExternalStore 通知 → 新 config → 重渲染 SVG。
  // themeVariant 只作为取色时机信号（值不直接进色板），放 deps 触发重取色。
  const themeColors = useMemo(() => {
    void themeVariant;
    return resolveMermaidThemeColors();
  }, [themeVariant]);
  const dark = themeVariant !== "light" && themeVariant !== "eyecare";
  const mermaidConfig = useMemo(() => createMermaidConfig(themeColors, dark), [themeColors, dark]);
  const renderKey = `${themeVariant}:${hashMermaidCode(trimmedCode)}`;

  useEffect(() => {
    let cancelled = false;
    if (!trimmedCode) {
      setRenderState({ status: "plaintext" });
      return;
    }
    setRenderState({ status: "loading" });
    const renderId = `nezha-mermaid-${reactIdPrefix}-${hashMermaidCode(renderKey)}`;

    enqueueMermaidRender(async () => {
      const mermaid = await loadMermaid();
      mermaid.initialize(mermaidConfig);
      const { svg } = await mermaid.render(renderId, trimmedCode);
      return svg;
    })
      .then((svg) => {
        if (cancelled) return;
        setRenderState({ status: "ready", svg });
        onPreviewSvgChangeRef.current?.(svg);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        // 渲染失败回退纯文本是常态路径（流式中语法未写完），但要留可见日志，
        // 不能让「mermaid 是否生效」变成黑箱（AGENTS.md：silent catch 必须配 log）。
        console.warn("[MermaidBlock] render failed:", message);
        if (cancelled) return;
        setRenderState({ status: "plaintext" });
        onPreviewSvgChangeRef.current?.(null);
      });

    return () => {
      cancelled = true;
      onPreviewSvgChangeRef.current?.(null);
    };
  }, [mermaidConfig, reactIdPrefix, renderKey, trimmedCode]);

  return (
    <div className="nezha-mermaid" data-mermaid-block="">
      {onOpenPreview && renderState.status === "ready" && (
        <button
          type="button"
          className="nezha-mermaid-expand"
          title={t("mermaid.openPreview")}
          onClick={onOpenPreview}
        >
          <Maximize2 size={13} />
        </button>
      )}
      {renderState.status === "loading" && (
        <div className="nezha-mermaid-loading">
          <Loader2 size={14} className="nezha-mermaid-loading-spin" />
          <span>{t("mermaid.loading")}</span>
        </div>
      )}
      {renderState.status === "plaintext" && (
        <pre className="nezha-mermaid-plain">
          <code>{code}</code>
        </pre>
      )}
      {renderState.status === "ready" && (
        <div
          role="img"
          aria-label={t("mermaid.ariaLabel")}
          className="nezha-mermaid-svg"
          onDoubleClick={onOpenPreview}
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
        />
      )}
    </div>
  );
}
