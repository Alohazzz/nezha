import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { UpdateInfo } from "../../types";
import s from "../../styles";

export function UpdateBanner({
  info,
  onView,
  onDismiss,
}: {
  info: UpdateInfo;
  onView: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  return (
    <div style={s.updateBanner}>
      <span style={s.updateBannerText}>{t("update.bannerText", { version: info.version })}</span>
      <button style={s.updateBannerBtn} onClick={onView}>
        {t("update.viewUpdate")}
      </button>
      <button
        style={s.updateBannerClose}
        onClick={onDismiss}
        title={t("common.close")}
        data-testid="update-banner-dismiss"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
