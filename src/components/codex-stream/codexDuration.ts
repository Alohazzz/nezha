import { splitElapsedSeconds } from "./codexEntryShared";

// 轮次耗时文案（对标 ZCode formatConversationWorkDuration）。
//
// 分工：`formatDuration`（codexEntryShared）是**条目级**的紧凑形态（850ms /
// 1.2s / 3m 6s），给工具卡摘要行的右侧 meta 用；这里是**整轮级**的本地化文案
// （中文「10 分 59 秒」/ 英文「10m 59s」），给轮次折叠头与完成页脚用。
// 两者不合并：条目级要亚秒精度与短后缀，整轮级要读得出量级、跟随界面语言。

type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * 毫秒 → 本地化时长文案。分段最多两级（时+分 / 分+秒 / 秒），与 ZCode 一致：
 * 「1 小时 2 分」比「1 小时 2 分 3 秒」更易扫读。
 * 少于 1 秒按 1 秒计——「已工作 0 秒」在刚起的轮次上像坏掉了。
 */
export function formatWorkDuration(t: Translate, ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const { hours, minutes, seconds } = splitElapsedSeconds(totalSeconds);
  if (hours > 0) return t("codex.duration.hours", { hours, minutes, seconds });
  if (minutes > 0) return t("codex.duration.minutes", { minutes, seconds });
  return t("codex.duration.seconds", { seconds });
}
