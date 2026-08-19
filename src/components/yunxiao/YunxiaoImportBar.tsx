import { useI18n } from "../../i18n";
import { SelectField } from "./SelectField";
import s from "../../styles";

export function YunxiaoImportBar({
  targetProjectId,
  onTargetProjectChange,
  options,
}: {
  targetProjectId: string;
  onTargetProjectChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const { t } = useI18n();

  return (
    <div style={s.yunxiaoToolbar}>
      <label style={s.yunxiaoFieldLabel}>{t("yunxiao.importToProject")}</label>
      <SelectField
        value={targetProjectId}
        onChange={onTargetProjectChange}
        options={options}
        placeholder={t("yunxiao.selectProject")}
      />
    </div>
  );
}
