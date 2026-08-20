import { FileMentionField } from "./FileMention";
import { ISSUE_FORM_FIELDS, type IssueFormKind } from "./issueForms";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 云效补充表单字段渲染：所有字段（含标题）支持 @ 引用文件路径。 */
export function SupplementFields({
  formKind,
  values,
  projectPath,
  onFieldChange,
}: {
  formKind: IssueFormKind;
  values: Record<string, string>;
  projectPath: string;
  onFieldChange: (key: string, value: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={s.yunxiaoFormFields}>
      {ISSUE_FORM_FIELDS[formKind].map((field) => (
        <label key={field.key} style={s.yunxiaoFormField}>
          <span style={s.yunxiaoFormFieldLabel}>{t(field.labelKey)}</span>
          <FileMentionField
            as={field.key === "subject" ? "input" : "textarea"}
            projectPath={projectPath}
            value={values[field.key] ?? ""}
            onChange={(v) => onFieldChange(field.key, v)}
            style={field.key === "subject" ? s.yunxiaoFormInput : s.yunxiaoFormTextarea}
          />
        </label>
      ))}
    </div>
  );
}
