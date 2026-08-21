import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Plus, Trash2, AlertTriangle } from "lucide-react";
import claudeLogo from "../../assets/claude.svg";
import chatgptLogo from "../../assets/chatgpt.svg";
import type {
  Project,
  Skill,
  SkillDataStatus,
  SkillInstallation,
  AgentType,
} from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";
import { SkillInstallDialog } from "./SkillInstallDialog";

interface Props {
  skill: Skill;
  allProjects: Project[];
  onClose: () => void;
  onChanged: () => void;
}

const AGENT_LABEL: Record<AgentType, string> = {
  claude: "Claude",
  codex: "Codex",
  dsh: "DSH",
};

const AGENT_LOGO: Record<AgentType, string> = {
  claude: claudeLogo,
  codex: chatgptLogo,
  dsh: "",
};

export function SkillManageDialog({ skill, allProjects, onClose, onChanged }: Props) {
  const { t } = useI18n();
  const [installations, setInstallations] = useState<SkillInstallation[]>([]);
  const [activeAgent, setActiveAgent] = useState<AgentType>("claude");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [dataStatuses, setDataStatuses] = useState<Record<string, SkillDataStatus | null>>({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataBusy, setDataBusy] = useState<string | null>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke<SkillInstallation[]>("list_skill_installations", { skillName: skill.name })
      .then((rows) => setInstallations(rows))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [skill.name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const projectInstallations = useMemo(
    () => installations.filter((ins) => ins.scope === "project" || ins.projectId !== ""),
    [installations],
  );

  useEffect(() => {
    if (projectInstallations.length === 0) {
      setDataStatuses({});
      return;
    }
    let cancelled = false;
    setDataLoading(true);
    Promise.all(
      projectInstallations.map((ins) =>
        invoke<SkillDataStatus>("get_skill_data_status", {
          skillName: ins.skillName,
          projectId: ins.projectId,
        })
          .then((status) => [ins.projectId, status] as const)
          .catch(() => [ins.projectId, null] as const),
      ),
    )
      .then((rows) => {
        if (cancelled) return;
        const map: Record<string, SkillDataStatus | null> = {};
        rows.forEach(([pid, status]) => {
          map[pid] = status;
        });
        setDataStatuses(map);
      })
      .finally(() => {
        if (!cancelled) setDataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectInstallations]);

  const runDataAction = useCallback(
    async (
      ins: SkillInstallation,
      action: "open" | "backup" | "build",
      status: SkillDataStatus | null,
    ) => {
      setDataBusy(ins.projectId);
      setError(null);
      setDataMessage(null);
      try {
        if (action === "open") {
          if (!status?.dataPath) throw new Error(t("skill.data.noDataDir"));
          const project = allProjects.find((p) => p.id === ins.projectId);
          if (!project) throw new Error("Project not found");
          await invoke("open_in_system_file_manager", {
            path: status.dataPath,
            projectPath: project.path,
          });
          setDataMessage(t("skill.data.opened"));
        } else if (action === "backup") {
          const backupPath = await invoke<string>("backup_skill_data", {
            skillName: ins.skillName,
            projectId: ins.projectId,
          });
          setDataMessage(t("skill.data.backupDone", { path: backupPath }));
        } else {
          const output = await invoke<string>("run_skill_data_build", {
            skillName: ins.skillName,
            projectId: ins.projectId,
          });
          setDataMessage(
            output.trim()
              ? t("skill.data.buildDoneWithOutput", { output: output.trim() })
              : t("skill.data.buildDone"),
          );
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setDataBusy(null);
        refresh();
      }
    },
    [allProjects, refresh, t],
  );

  const handleUninstall = useCallback(
    async (ins: SkillInstallation) => {
      try {
        await invoke("uninstall_skill", {
          skillName: ins.skillName,
          projectId: ins.projectId,
          agent: ins.agent,
        });
        refresh();
        onChanged();
      } catch (e) {
        setError(String(e));
      }
    },
    [refresh, onChanged],
  );

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  const agentCounts = {
    claude: installations.filter((ins) => ins.agent === "claude").length,
    codex: installations.filter((ins) => ins.agent === "codex").length,
  };
  const visibleInstallations = installations.filter((ins) => ins.agent === activeAgent);

  return (
    <div style={s.modalOverlay} onClick={handleOverlayClick}>
      <div style={s.skillDialogBox}>
        <div style={s.skillDialogHeader}>
          <div style={s.skillDialogHeaderMain}>
            <div style={s.skillDialogTitleRow}>
              <div style={s.skillDialogTitle}>{skill.displayName || skill.name}</div>
              <span
                style={
                  skill.scope === "project"
                    ? s.skillScopeBadgeProject
                    : s.skillScopeBadgeUniversal
                }
              >
                {skill.scope === "project"
                  ? t("skill.scope.project")
                  : t("skill.scope.universal")}
              </span>
            </div>
            {skill.displayName && skill.displayName !== skill.name ? (
              <div style={s.skillDialogSubtitle}>{skill.name}</div>
            ) : null}
            {skill.description ? (
              <div style={s.skillDialogDesc}>{skill.description}</div>
            ) : null}
          </div>
          <button type="button" style={s.modalCloseBtn} onClick={onClose}>
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div style={s.skillDialogToolbar}>
          <div style={s.skillDialogSectionTitle}>{t("skill.manage.installedTitle")}</div>
          <button
            type="button"
            style={s.skillDialogPrimaryBtn}
            onClick={() => setInstallDialogOpen(true)}
          >
            <Plus size={13} strokeWidth={2.2} />
            <span>{t("skill.manage.installNew")}</span>
          </button>
        </div>

        <div style={s.skillDialogTabs}>
          {(["claude", "codex"] as const).map((agentKey) => {
            const active = activeAgent === agentKey;
            return (
              <button
                key={agentKey}
                type="button"
                style={active ? s.skillDialogTabActive : s.skillDialogTab}
                onClick={() => setActiveAgent(agentKey)}
              >
                <img src={AGENT_LOGO[agentKey]} style={s.skillInstallAgentLogo} alt="" />
                <span>{AGENT_LABEL[agentKey]}</span>
                <span style={s.skillDialogTabCount}>{agentCounts[agentKey]}</span>
              </button>
            );
          })}
        </div>

        <div style={s.skillDialogList}>
          {loading ? (
            <div style={s.skillDialogEmpty}>{t("skill.manage.loading")}</div>
          ) : visibleInstallations.length === 0 ? (
            <div style={s.skillDialogEmpty}>
              {installations.length === 0
                ? t("skill.manage.empty")
                : t("skill.manage.emptyForAgent", { agent: AGENT_LABEL[activeAgent] })}
            </div>
          ) : (
            visibleInstallations.map((ins) => {
              const project = allProjects.find((p) => p.id === ins.projectId);
              const isUniversal = ins.scope === "universal" || ins.projectId === "";
              const projectName = isUniversal
                ? t("skill.manage.globalTarget")
                : project?.name ?? ins.projectId;
              const broken = ins.health && ins.health !== "ok";
              return (
                <div key={`${ins.projectId}-${ins.agent}`} style={s.skillInstallRow}>
                  <div style={s.skillInstallRowMain}>
                    <div style={s.skillInstallRowTitle}>{projectName}</div>
                    <div style={s.skillInstallRowMeta}>
                      <img src={AGENT_LOGO[ins.agent]} style={s.skillInstallAgentLogo} alt="" />
                      <span>{AGENT_LABEL[ins.agent]}</span>
                      <span style={s.skillInstallRowSep}>·</span>
                      <span style={s.skillInstallRowPath}>{ins.linkPath}</span>
                    </div>
                    {broken ? (
                      <div style={s.skillInstallRowWarn}>
                        <AlertTriangle size={11} strokeWidth={2} />
                        <span>{t(`skill.manage.health.${ins.health}`)}</span>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    style={s.skillInstallUninstallBtn}
                    onClick={() => handleUninstall(ins)}
                    title={t("skill.manage.uninstall")}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                    <span>{t("skill.manage.uninstall")}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {skill.scope === "project" ? (
          <>
            <div style={s.skillDialogSectionTitle}>{t("skill.data.title")}</div>
            {projectInstallations.length === 0 ? (
              <div style={s.skillDialogEmpty}>{t("skill.data.notInstalled")}</div>
            ) : dataLoading ? (
              <div style={s.skillDialogEmpty}>{t("skill.manage.loading")}</div>
            ) : (
              <div style={s.skillDataList}>
                {projectInstallations.map((ins) => {
                  const project = allProjects.find((p) => p.id === ins.projectId);
                  const status = dataStatuses[ins.projectId] ?? null;
                  const busy = dataBusy === ins.projectId;
                  return (
                    <div key={`data-${ins.projectId}`} style={s.skillDataRow}>
                      <div style={s.skillInstallRowMain}>
                        <div style={s.skillInstallRowTitle}>{project?.name ?? ins.projectId}</div>
                        <div style={s.skillInstallRowMeta}>
                          <span style={s.skillInstallRowPath}>
                            {status?.dataPath ?? ins.dataPath ?? "—"}
                          </span>
                        </div>
                        <div style={s.skillInstallRowMeta}>
                          {status?.exists ? (
                            <span>
                              {t("skill.data.files", { count: status.fileCount })}
                              {status.lastModified
                                ? ` · ${t("skill.data.modified", {
                                    time: new Date(status.lastModified).toLocaleString(),
                                  })}`
                                : ""}
                            </span>
                          ) : (
                            <span style={s.skillDataMissing}>{t("skill.data.noDataDir")}</span>
                          )}
                        </div>
                      </div>
                      <div style={s.skillDataActions}>
                        <button
                          type="button"
                          style={s.skillDataBtn}
                          onClick={() => runDataAction(ins, "open", status)}
                          disabled={busy}
                        >
                          {t("skill.data.open")}
                        </button>
                        <button
                          type="button"
                          style={s.skillDataBtn}
                          onClick={() => runDataAction(ins, "backup", status)}
                          disabled={busy || !status?.exists}
                        >
                          {busy ? t("skill.data.busy") : t("skill.data.backup")}
                        </button>
                        <button
                          type="button"
                          style={s.skillDataBtn}
                          onClick={() => runDataAction(ins, "build", status)}
                          disabled={busy}
                        >
                          {busy ? t("skill.data.busy") : t("skill.data.build")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {dataMessage ? <div style={s.skillDataMsg}>{dataMessage}</div> : null}
          </>
        ) : null}

        {error ? <div style={s.skillHubError}>{error}</div> : null}
      </div>

      {installDialogOpen ? (
        <SkillInstallDialog
          skill={skill}
          allProjects={allProjects}
          existingInstallations={installations}
          onClose={() => setInstallDialogOpen(false)}
          onInstalled={() => {
            setInstallDialogOpen(false);
            refresh();
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
