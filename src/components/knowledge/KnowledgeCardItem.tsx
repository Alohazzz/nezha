import { useI18n } from "../../i18n";

export interface KnowledgeCardItemProps {
  /** 模块名，形如 `Nto.His.Diagnosis`。 */
  module: string;
  active?: boolean;
  /** 相对 HEAD 有未提交改动（本地已保存但未发布）。 */
  modified?: boolean;
  onClick: () => void;
}

/** 把 `Nto.His.Diagnosis` 拆成展示名 `Diagnosis` 与命名空间 `Nto.His`；无点号则整体作为展示名。 */
export function splitModule(module: string): { name: string; namespace: string } {
  const idx = module.lastIndexOf(".");
  if (idx <= 0 || idx === module.length - 1) {
    return { name: module, namespace: "" };
  }
  return { name: module.slice(idx + 1), namespace: module.slice(0, idx) };
}

/**
 * 知识库模块卡片项（右侧工具条「知识库」面板与设置页知识图谱共用）。
 * 视觉结构：字母角标 +（短名 / 命名空间）+ 可选「已改」徽标。
 */
export function KnowledgeCardItem({
  module,
  active,
  modified,
  onClick,
}: KnowledgeCardItemProps) {
  const { t } = useI18n();
  const { name, namespace } = splitModule(module);
  const initial = name.charAt(0).toUpperCase();

  return (
    <button
      type="button"
      className="knowledge-card-item"
      data-active={active || undefined}
      data-modified={modified || undefined}
      onClick={onClick}
      title={module}
      aria-label={module}
    >
      <span className="kpi-glyph" aria-hidden="true">
        {initial}
      </span>
      <span className="kpi-main">
        <span className="kpi-name">{name}</span>
        {namespace && <span className="kpi-ns">{namespace}</span>}
      </span>
      {modified && <span className="kpi-badge">{t("knowledgePanel.modified")}</span>}
    </button>
  );
}
