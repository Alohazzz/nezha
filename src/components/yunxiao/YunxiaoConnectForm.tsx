import { useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  YunxiaoOrganization,
  YunxiaoProject,
} from "../../types";
import { useI18n } from "../../i18n";
import { SelectField } from "./SelectField";
import s from "../../styles";

export function YunxiaoConnectForm({
  tokenInput,
  onTokenChange,
  organizations,
  selectedOrgId,
  onOrgChange,
  cloudProjects,
  selectedProjectId,
  onProjectChange,
  organizationLoading,
  projectLoading,
  saving,
  currentUserIdInput,
  onCurrentUserIdChange,
  currentUserNameInput,
  onCurrentUserNameChange,
  onFetchOrganizations,
  onFetchProjects,
  onSave,
}: {
  tokenInput: string;
  onTokenChange: (v: string) => void;
  organizations: YunxiaoOrganization[];
  selectedOrgId: string;
  onOrgChange: (v: string) => void;
  cloudProjects: YunxiaoProject[];
  selectedProjectId: string;
  onProjectChange: (v: string) => void;
  organizationLoading: boolean;
  projectLoading: boolean;
  saving: boolean;
  currentUserIdInput: string;
  onCurrentUserIdChange: (v: string) => void;
  currentUserNameInput: string;
  onCurrentUserNameChange: (v: string) => void;
  onFetchOrganizations: () => void;
  onFetchProjects: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const [saveHover, setSaveHover] = useState(false);
  const orgOptions = organizations.map((o) => ({ value: o.id, label: o.name }));
  const projectOptions = cloudProjects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <div style={s.yunxiaoConnect}>
      <div style={s.yunxiaoConnectCard}>
        <div style={s.yunxiaoConnectTitle}>{t("yunxiao.connectTitle")}</div>
        <div style={s.yunxiaoHint}>{t("yunxiao.notConnected")}</div>
        <div style={s.yunxiaoField}>
          <label style={s.yunxiaoFieldLabel}>{t("yunxiao.tokenLabel")}</label>
          <input
            style={s.yunxiaoInput}
            type="password"
            value={tokenInput}
            onChange={(e) => onTokenChange(e.target.value)}
            placeholder={t("yunxiao.tokenPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div style={s.yunxiaoFieldRow}>
          <button
            type="button"
            style={organizationLoading ? s.yunxiaoPrimaryBtnDisabled : s.yunxiaoPrimaryBtn}
            disabled={organizationLoading}
            onClick={onFetchOrganizations}
          >
            {organizationLoading && <Loader2 size={12} className="spin" />}
            {organizationLoading
              ? t("yunxiao.fetchingOrganizations")
              : t("yunxiao.fetchOrganizations")}
          </button>
        </div>
        {organizations.length > 0 && (
          <div style={s.yunxiaoField}>
            <label style={s.yunxiaoFieldLabel}>{t("yunxiao.selectOrganization")}</label>
            <SelectField
              value={selectedOrgId}
              onChange={onOrgChange}
              options={orgOptions}
              placeholder={t("yunxiao.selectOrganization")}
            />
          </div>
        )}
        {selectedOrgId && (
          <div style={s.yunxiaoFieldRow}>
            <button
              type="button"
              style={projectLoading ? s.yunxiaoPrimaryBtnDisabled : s.yunxiaoPrimaryBtn}
              disabled={projectLoading}
              onClick={onFetchProjects}
            >
              {projectLoading && <Loader2 size={12} className="spin" />}
              {projectLoading ? t("yunxiao.loadingProjects") : t("yunxiao.loadProjects")}
            </button>
          </div>
        )}
        {cloudProjects.length > 0 && (
          <div style={s.yunxiaoField}>
            <label style={s.yunxiaoFieldLabel}>{t("yunxiao.selectProject")}</label>
            <SelectField
              value={selectedProjectId}
              onChange={onProjectChange}
              options={projectOptions}
              placeholder={t("yunxiao.selectProject")}
            />
          </div>
        )}
        <div style={s.yunxiaoField}>
          <label style={s.yunxiaoFieldLabel}>{t("yunxiao.currentUserIdLabel")}</label>
          <input
            style={s.yunxiaoInput}
            value={currentUserIdInput}
            onChange={(e) => onCurrentUserIdChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div style={s.yunxiaoField}>
          <label style={s.yunxiaoFieldLabel}>{t("yunxiao.currentUserNameLabel")}</label>
          <input
            style={s.yunxiaoInput}
            value={currentUserNameInput}
            onChange={(e) => onCurrentUserNameChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div style={s.yunxiaoHint}>{t("yunxiao.currentUserHint")}</div>
        <div style={s.yunxiaoFieldRow}>
          <button
            type="button"
            style={
              saving
                ? s.yunxiaoPrimaryBtnDisabled
                : saveHover
                  ? s.yunxiaoPrimaryBtnHover
                  : s.yunxiaoPrimaryBtn
            }
            disabled={saving}
            onClick={onSave}
            onMouseEnter={() => setSaveHover(true)}
            onMouseLeave={() => setSaveHover(false)}
          >
            {saving && <Loader2 size={12} className="spin" />}
            {saving ? t("yunxiao.saving") : t("yunxiao.saveConnection")}
          </button>
        </div>
        <div style={s.yunxiaoHint}>{t("yunxiao.hint")}</div>
      </div>
    </div>
  );
}
