import { useUpdate } from "../../hooks/useUpdate";
import { UpdateBanner } from "./UpdateBanner";
import { UpdateDialog } from "./UpdateDialog";

export function UpdateController() {
  const upd = useUpdate();

  return (
    <>
      {upd.phase === "available" && upd.info && !upd.bannerDismissed && (
        <UpdateBanner
          info={upd.info}
          onView={() => upd.setDialogOpen(true)}
          onDismiss={upd.dismissBanner}
        />
      )}
      {upd.dialogOpen && (
        <UpdateDialog
          info={upd.info}
          phase={upd.phase}
          error={upd.error}
          progress={upd.progress}
          activeCount={upd.activeCount}
          checking={upd.checking}
          onClose={() => upd.setDialogOpen(false)}
          onDownload={upd.downloadAndInstall}
          onInstall={upd.confirmInstall}
        />
      )}
    </>
  );
}
