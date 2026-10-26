import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

// ── 统一工具卡骨架（issue #117 T2，对标 ZCode ToolLayout）────────────────────
// 协议化摘要行：图标 / 类别标签 chip / 主文本 / 元信息 slot / 状态 / 状态 tooltip
// / 折叠 children。五类条目卡按行为矩阵传 props 迁移（T3），本组件只管骨架行为：
//
// - 展开状态持久：模块级 Map<entryId, boolean>，跨任务切换 / 跨卸载重挂载保持。
//   不进 React 状态、不进 localStorage；带条目上限防泄漏（长会话丢最老记录）。
// - 自动边沿：进入 running → 自动展开一次；running → 完成边沿 → 自动收起一次。
//   流式增长（revision 递增）不参与触发——进入 running 即展开，避免每帧比较。
//   用户手动 toggle 后该条目的自动逻辑**永久让位**（manualWins ref）。
//   边沿用 ref 比较前后值识别，只在真正切换时 setState——高频帧回调不 setState
//   （红线）。
// - 失败态：状态词虚线下划线，Radix Popover 展示错误详情尾部 + 复制按钮。
// - 运行态视觉：类别标签文案扫光（codex-stream.css 的 shimmer keyframes），
//   不用旋转图标/spinner。
// - 不折叠用法（消息 / 计划类）：collapsible={false}，children 直接渲染，
//   不渲染摘要行按钮。

export type CodexToolStatus = "running" | "ok" | "failed";

/** 展开状态注册表：模块级持久（测试可通过此引用清理）。 */
export const codexToolCardExpansion = new Map<string, boolean>();

/** 防泄漏上限：超出后丢最老记录（Map 迭代序即插入序，读时挪队尾近似 LRU）。 */
const EXPANSION_MAP_CAP = 2000;

function readExpansion(entryId: string): boolean | undefined {
  const value = codexToolCardExpansion.get(entryId);
  if (value !== undefined) {
    codexToolCardExpansion.delete(entryId);
    codexToolCardExpansion.set(entryId, value);
  }
  return value;
}

function writeExpansion(entryId: string, expanded: boolean): void {
  codexToolCardExpansion.delete(entryId);
  codexToolCardExpansion.set(entryId, expanded);
  if (codexToolCardExpansion.size > EXPANSION_MAP_CAP) {
    const oldest = codexToolCardExpansion.keys().next().value;
    if (oldest !== undefined) codexToolCardExpansion.delete(oldest);
  }
}

/** 失败详情 tooltip：状态词触发，含错误尾部 + 复制按钮（user stories 12-13）。 */
function FailedDetailPopover({ detail, label }: { detail: string; label: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    };
  }, []);

  // 只展示错误尾部（最后 ~2000 字符）——tooltip 不承载全文
  const tail = detail.length > 2000 ? `…${detail.slice(-2000)}` : detail;

  const handleCopy = () => {
    navigator.clipboard.writeText(detail).then(() => {
      setCopied(true);
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="codex-stream-tool-status"
          data-status="failed"
          title={t("codex.tool.failedDetail")}
          style={{ ...s.codexToolStatus, ...s.codexToolStatusFailed }}
        >
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          style={s.codexToolFailPopover}
          data-testid="failure-detail"
        >
          <pre style={s.codexToolFailPre}>{tail}</pre>
          <button
            type="button"
            aria-label={t("common.copy")}
            title={copied ? t("codex.tool.copied") : t("common.copy")}
            onClick={handleCopy}
            style={{ ...s.codexToolFailCopy, ...(copied ? s.codexToolFailCopied : {}) }}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export const CodexToolCard = memo(function CodexToolCard({
  entryId,
  icon,
  category,
  text,
  meta,
  status,
  statusLabel,
  failureDetail,
  collapsible = true,
  defaultExpanded = false,
  autoExpandWhileRunning = true,
  autoCollapseOnDone = true,
  streamingRevision,
  onToggleExpand,
  children,
}: {
  /** 展开持久化主键：条目 id。 */
  entryId: string;
  icon: ReactNode;
  /** 类别标签 chip 文案（Command / MCP / File change / Thinking）。 */
  category: string;
  /** 摘要行主文本（命令、工具名等）。 */
  text: string;
  /** 元信息 slot：耗时 / exit code / diff 统计等。 */
  meta?: ReactNode;
  status: CodexToolStatus;
  /** 状态词覆盖（如 "exit 1"）；缺省按 status 出 Running / Done / Failed。 */
  statusLabel?: string;
  /** 非空时失败态渲染状态 tooltip（错误详情尾部 + 复制）。 */
  failureDetail?: string | null;
  /** false = 不折叠形态（消息 / 计划类）：children 直接渲染，无摘要行。 */
  collapsible?: boolean;
  /** 初始无记录时的默认展开态（行为矩阵：默认收起）。 */
  defaultExpanded?: boolean;
  /** 行为矩阵：流式中自动展开（命令 / MCP 开，思考关）。 */
  autoExpandWhileRunning?: boolean;
  /** 行为矩阵：完成边沿自动收起（命令 / MCP 开，思考关）。 */
  autoCollapseOnDone?: boolean;
  /** 条目级流式修订号（T1 归并层的 revision）：running 且首次出现时触发
   * 自动展开边沿。仅在 status === "running" 期间有意义。 */
  streamingRevision?: number;
  /** 展开/收起回调（父级同步箭头方向等）。 */
  onToggleExpand?: (expanded: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(() => {
    if (!collapsible) return true;
    const stored = readExpansion(entryId);
    if (stored !== undefined) return stored;
    return defaultExpanded || (autoExpandWhileRunning && status === "running");
  });

  // ── 手动优先：用户 toggle 过的条目，自动逻辑永久让位 ─────────────────────
  const manualWinsRef = useRef(false);

  // ── 边沿检测：ref 记住上次 status / revision，effect 比较前后值；只在真正
  // 发生切换时 setState——revision 每帧递增的重渲染不额外触发状态写入（红线）。
  const prevStatusRef = useRef(status);
  const prevRevisionRef = useRef<number | null>(
    typeof streamingRevision === "number" ? streamingRevision : null,
  );

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prevStatus === status) return;
    if (!collapsible || manualWinsRef.current) return;

    // 完成边沿：running → ok/failed → 自动收起一次
    if (autoCollapseOnDone && prevStatus === "running") {
      setExpanded(false);
      writeExpansion(entryId, false);
      onToggleExpand?.(false);
      return;
    }
    // 进入 running 边沿兜底（首帧 mounted 就 running 的展开在 useState 初始化
    // 覆盖；这里补 running 晚到的情形）
    if (autoExpandWhileRunning && status === "running") {
      setExpanded(true);
      writeExpansion(entryId, true);
      onToggleExpand?.(true);
    }
  }, [
    status,
    collapsible,
    autoCollapseOnDone,
    autoExpandWhileRunning,
    entryId,
    onToggleExpand,
  ]);

  // 流式增长边沿：running 且 revision 递增 → 自动展开一次（乱序场景：started
  // 帧丢失、首帧就是 delta，status 一直是 running 没有 status 边沿，靠 revision
  // 抓住流式开始）。同样只在边沿第一次命中时 setState。
  useEffect(() => {
    if (!collapsible || manualWinsRef.current) return;
    if (status !== "running" || !autoExpandWhileRunning) {
      prevRevisionRef.current = typeof streamingRevision === "number" ? streamingRevision : null;
      return;
    }
    const prev = prevRevisionRef.current;
    prevRevisionRef.current = typeof streamingRevision === "number" ? streamingRevision : null;
    if (prev === null && typeof streamingRevision === "number") {
      // 首个 revision 到达：流式确认开始 → 展开
      setExpanded((was) => {
        if (was) return was;
        writeExpansion(entryId, true);
        onToggleExpand?.(true);
        return true;
      });
    }
  }, [
    streamingRevision,
    status,
    collapsible,
    autoExpandWhileRunning,
    entryId,
    onToggleExpand,
  ]);

  const handleToggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      manualWinsRef.current = true;
      writeExpansion(entryId, next);
      onToggleExpand?.(next);
      return next;
    });
  }, [entryId, onToggleExpand]);

  // ── 不折叠形态：children 直接渲染 ──────────────────────────────────────────
  if (!collapsible) {
    return <div style={s.codexToolCard}>{children}</div>;
  }

  const running = status === "running";
  const failed = status === "failed";
  const label =
    statusLabel ??
    (running ? t("codex.tool.running") : failed ? t("codex.tool.failed") : t("codex.tool.done"));
  const showFailTooltip = failed && typeof failureDetail === "string" && failureDetail.length > 0;

  return (
    <div style={s.codexToolCard} data-status={status} className="codex-stream-tool-card">
      <button
        type="button"
        className="codex-stream-tool-header"
        style={{ ...s.codexToolHeader, ...(expanded ? s.codexToolHeaderExpanded : {}) }}
        onClick={handleToggle}
      >
        <span style={s.codexToolIcon}>{icon}</span>
        <span
          className="codex-stream-tool-category"
          style={s.codexToolCategory}
          data-running={running || undefined}
        >
          {category}
        </span>
        <span style={s.codexToolText}>{text}</span>
        {meta}
        {showFailTooltip ? (
          <FailedDetailPopover detail={failureDetail!} label={statusLabel ?? label} />
        ) : (
          <span
            className="codex-stream-tool-status"
            style={{ ...s.codexToolStatus, ...(failed ? s.codexToolStatusFailed : {}) }}
            data-status={status}
          >
            {label}
          </span>
        )}
        {expanded ? (
          <ChevronDown size={11} style={s.codexToolChevron} />
        ) : (
          <ChevronRight size={11} style={s.codexToolChevron} />
        )}
      </button>
      {expanded && <div style={s.codexToolBody}>{children}</div>}
    </div>
  );
});
