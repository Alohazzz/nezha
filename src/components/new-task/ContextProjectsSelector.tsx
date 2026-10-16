import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, FolderGit2, Layers, Search, X } from "lucide-react";
import type { Project } from "../../types";
import { useI18n } from "../../i18n";
import s from "../../styles";

/** 跨仓库任务上下文：附加项目勾选器。
 *  候选 = 除主项目外的全部 Nezha 项目，带搜索；勾选结果经 onSubmit 随任务落盘，
 *  启动时由后端注入 CLI `--add-dir`。DSH 无跨目录机制，禁用并标注原因。 */
export function ContextProjectsSelector({
  otherProjects,
  selectedIds,
  disabled,
  disabledReason,
  onToggle,
  onClear,
}: {
  /** 候选项目（调用方保证不含主项目） */
  otherProjects: Project[];
  /** 已勾选的附加项目 id */
  selectedIds: string[];
  /** DSH 等不支持跨目录的 agent 置 true */
  disabled: boolean;
  /** disabled 时的 tooltip 文案 */
  disabledReason?: string;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return otherProjects;
    return otherProjects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [otherProjects, search]);

  const selectedProjects = useMemo(
    () =>
      selectedIds
        .map((id) => otherProjects.find((p) => p.id === id))
        .filter((p): p is Project => !!p),
    [selectedIds, otherProjects],
  );

  const triggerLabel =
    selectedProjects.length > 0
      ? selectedProjects.map((p) => p.name).join(", ")
      : t("newTask.contextProjectsNone");

  return (
    <Popover.Root open={open} onOpenChange={disabled ? undefined : setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          style={disabled ? s.contextProjectsTriggerDisabled : s.contextProjectsTrigger}
          aria-label={`${t("newTask.contextProjects")}: ${triggerLabel}`}
          title={disabled ? disabledReason : triggerLabel}
          disabled={disabled}
        >
          <Layers size={15} strokeWidth={2.2} style={s.contextProjectsIcon} />
          <span style={s.contextProjectsTriggerLabel}>{triggerLabel}</span>
          {selectedIds.length > 0 && (
            <span style={s.contextProjectsBadge}>{selectedIds.length}</span>
          )}
          <ChevronDown size={14} strokeWidth={2.2} style={s.contextProjectsChevron} />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={6}
          style={s.contextProjectsPopoverContent}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div style={s.contextProjectsSearchRow}>
            <Search size={13} strokeWidth={2} style={s.contextProjectsSearchIcon} />
            <input
              type="text"
              value={search}
              placeholder={t("newTask.contextProjectsSearchPlaceholder")}
              onChange={(e) => setSearch(e.target.value)}
              style={s.contextProjectsSearchInput}
            />
            {selectedIds.length > 0 && (
              <button
                type="button"
                style={s.contextProjectsClearBtn}
                onClick={() => {
                  onClear();
                  setSearch("");
                }}
                title={t("newTask.contextProjectsClear")}
              >
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          <div style={s.contextProjectsList}>
            {filtered.length === 0 && (
              <div style={s.contextProjectsEmpty}>{t("newTask.contextProjectsEmpty")}</div>
            )}
            {filtered.map((p) => {
              const selected = selectedIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className="branch-popover-item"
                  style={selected ? s.contextProjectsItemSelected : s.contextProjectsItem}
                  aria-pressed={selected}
                  onClick={() => onToggle(p.id)}
                >
                  <FolderGit2 size={14} strokeWidth={2} style={s.contextProjectsItemIcon} />
                  <span style={s.contextProjectsItemBody}>
                    <span style={s.contextProjectsItemName}>{p.name}</span>
                    <span style={s.contextProjectsItemPath}>{p.path}</span>
                  </span>
                  {selected && <Check size={14} strokeWidth={2.2} />}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
