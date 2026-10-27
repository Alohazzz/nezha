import { memo, useEffect, useState } from "react";
import { useI18n } from "../../i18n";

// 流视图级「工作中 N 秒」活性指示器：structured 任务整轮运行期间常驻流尾，
// 与条目级 CodexLiveDuration（单条卡片上的跳动秒数）互补——长思考 / 长命令
// 等 delta 静默期条目流完全不动，没有这条指示会看起来像卡住（Zcode 同款）。
// 计时锚点 = 本组件挂载时刻（流视图仅 running 态挂载它，即本轮开始观察点）；
// running 翻 false 即卸载，不会出现定格残影。1s 局部 setState 与
// CodexLiveDuration 同规格，不属于 PTY 高频回调红线。

export const CodexWorkingIndicator = memo(function CodexWorkingIndicator() {
  const { t } = useI18n();
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSec(0);
    const timer = setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="codex-stream-working" role="status">
      <span className="codex-stream-working-spinner" aria-hidden="true" />
      <span>{t("codex.stream.working", { seconds: elapsedSec })}</span>
    </div>
  );
});
