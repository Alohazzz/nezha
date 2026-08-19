import { useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, Settings } from "lucide-react";
import { useI18n } from "../../i18n";
import s from "../../styles";

export function YunxiaoHeader({
  onBack,
  meta,
  configured,
  refreshLoading,
  onRefresh,
  onReconnect,
}: {
  onBack: () => void;
  meta: string;
  configured: boolean;
  refreshLoading: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
}) {
  const { t } = useI18n();
  const [backHover, setBackHover] = useState(false);
  const [refreshHover, setRefreshHover] = useState(false);
  const [settingsHover, setSettingsHover] = useState(false);

  return (
    <div style={s.yunxiaoHeader}>
      <button
        type="button"
        style={backHover ? s.yunxiaoBackBtnHover : s.yunxiaoBackBtn}
        onClick={onBack}
        title={t("yunxiao.back")}
        aria-label={t("yunxiao.back")}
        onMouseEnter={() => setBackHover(true)}
        onMouseLeave={() => setBackHover(false)}
      >
        <ArrowLeft size={14} strokeWidth={2} />
      </button>
      <div>
        <div style={s.yunxiaoHeaderTitle}>{t("yunxiao.title")}</div>
        <div style={s.yunxiaoHeaderMeta}>{meta}</div>
      </div>
      <div style={s.yunxiaoHeaderActions}>
        {configured && (
          <button
            type="button"
            style={refreshHover ? s.yunxiaoToolbarBtnHover : s.yunxiaoToolbarBtn}
            onClick={onRefresh}
            title={t("yunxiao.refresh")}
            aria-label={t("yunxiao.refresh")}
            onMouseEnter={() => setRefreshHover(true)}
            onMouseLeave={() => setRefreshHover(false)}
          >
            {refreshLoading ? (
              <Loader2 size={13} strokeWidth={2} className="spin" />
            ) : (
              <RefreshCw size={13} strokeWidth={2} />
            )}
          </button>
        )}
        <button
          type="button"
          style={settingsHover ? s.yunxiaoToolbarBtnHover : s.yunxiaoToolbarBtn}
          onClick={onReconnect}
          title={t("yunxiao.reconnect")}
          aria-label={t("yunxiao.reconnect")}
          onMouseEnter={() => setSettingsHover(true)}
          onMouseLeave={() => setSettingsHover(false)}
        >
          <Settings size={13} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
