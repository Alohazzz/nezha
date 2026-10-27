import { memo, useEffect, useState } from "react";
import { formatDuration } from "./codexEntryShared";

// 动态计时展示（issue #119）：running 条目摘要行上的跳动秒数。仅运行中条目
// 挂载 interval（1s 局部 setState，spec 允许的组件内短生命周期状态，不属于
// PTY 高频回调红线）；完成（endedAtMs 有值）即定格 formatDuration(ended-started)，
// interval 从不启动——挂载即定格渲染。

export const CodexLiveDuration = memo(function CodexLiveDuration({
  startedAtMs,
  endedAtMs,
}: {
  startedAtMs: number | null | undefined;
  endedAtMs: number | null | undefined;
}) {
  const running = endedAtMs == null && startedAtMs != null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (startedAtMs == null) return null;
  // 定格路径同样夹非负：本地时钟占位起点 + 后端信封完成时刻的时钟偏差/
  // 乱序场景可能给出负差值（spec 明确的乱序兜底场景），渲染 "-0.3s" 是错的。
  if (!running) return <>{formatDuration(Math.max(0, endedAtMs! - startedAtMs))}</>;
  return <>{formatDuration(Math.max(0, now - startedAtMs))}</>;
});
