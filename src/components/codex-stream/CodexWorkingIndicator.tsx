import { memo, useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { splitElapsedSeconds } from "./codexEntryShared";

// 流视图级「工作中 N 秒」活性指示器：structured 任务整轮运行期间常驻流尾，
// 与条目级 CodexLiveDuration（单条卡片上的跳动秒数）互补——长思考 / 长命令
// 等 delta 静默期条目流完全不动，没有这条指示会看起来像卡住（Zcode 同款）。
// 计时锚点优先用调用方下发的 startedAtMs（本轮真实开始时刻，随数据持久，
// 切页面重挂载不会归零——ZCode resolveConversationTurnWorkDurationMs 同款：
// nowMs 只用于算差值，起点永远在数据里）；缺省回落挂载时刻（无任务级锚点
// 可用时的兜底）。running 翻 false 即卸载，不会出现定格残影。1s 局部
// setState 与 CodexLiveDuration 同规格，不属于 PTY 高频回调红线。
//
// 时长按组分段展示（≥1min 才出「分」，≥1h 才出「时」）：整轮跑十几分钟时
// “659 秒”这种裸秒数无法一眼读出量级，是本次要修的观感问题。

export const CodexWorkingIndicator = memo(function CodexWorkingIndicator({
  startedAtMs,
}: {
  /** 本轮开始时刻（毫秒）；缺省回落到组件挂载时刻。 */
  startedAtMs?: number | null;
}) {
  const { t } = useI18n();
  // 锚点只在挂载时取一次：运行中上游不会改写本轮起点，跟随 prop 变化反而
  // 会让中途的状态更新（如 input_required 往返）把已跑的秒数拽回去。
  const [anchorMs] = useState(() =>
    typeof startedAtMs === "number" && Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
  );
  // 首帧就算出真实差值：重挂载（切页面回来）的瞬间就要显示已跑秒数，
  // 不能先闪一帧「0 秒」再等 1s interval 跳到正确值。
  const [elapsedSec, setElapsedSec] = useState(() =>
    Math.max(0, Math.floor((Date.now() - anchorMs) / 1000)),
  );

  useEffect(() => {
    // clamp 0：后端信封时刻与本地时钟有偏差时锚点可能晚于 now，负秒数会渲染成「-1 秒」。
    const timer = setInterval(
      () => setElapsedSec(Math.max(0, Math.floor((Date.now() - anchorMs) / 1000))),
      1000,
    );
    return () => clearInterval(timer);
  }, [anchorMs]);

  const { hours, minutes, seconds } = splitElapsedSeconds(elapsedSec);
  const label =
    hours > 0
      ? t("codex.stream.workingHours", { hours, minutes, seconds })
      : minutes > 0
        ? t("codex.stream.workingMinutes", { minutes, seconds })
        : t("codex.stream.working", { seconds });

  return (
    <div className="codex-stream-working" role="status">
      <span className="codex-stream-working-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
});
