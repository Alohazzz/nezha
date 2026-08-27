import type { LucideIcon } from "lucide-react";
import {
  DEFAULT_SEND_SHORTCUT,
  DEFAULT_SHIFT_ENTER_NEWLINE,
  type SendShortcut,
} from "../../shortcuts";
import { DEFAULT_TERMINAL_SCROLLBACK } from "../../types";

export type NavKey =
  | "general"
  | "theme"
  | "fonts"
  | "shortcuts"
  | "hooks"
  | "skills"
  | "about"
  | "thanks"
  | "community"
  | "claude"
  | "codex"
  | "dsh";

export interface HookInstallStatus {
  node_path: string;
  script_path: string;
  claude_installed: boolean;
  codex_installed: boolean;
  error?: string;
}

export type HookReadinessReason = "ok" | "no_node" | "not_installed" | "version_too_low";

export interface HookAgentReadiness {
  agent: "claude" | "codex";
  usable: boolean;
  reason: HookReadinessReason;
  detectedVersion: string;
  minVersion: string;
}

export interface AgentModelOption {
  model: string;
  label?: string;
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  /** 模型来源：undefined/null = 手动添加；"file" = codex 配置文件同步；"rpc" = codex model/list 同步 */
  source?: string | null;
}

export interface AgentModelCatalog {
  models: AgentModelOption[];
  initialized: boolean;
  initializedAt?: number;
  sourceVersion?: string;
}

export const EMPTY_AGENT_MODEL_CATALOG: AgentModelCatalog = {
  models: [],
  initialized: false,
};

/** 云效 (Aliyun DevOps / Projex) 集成配置（token 仅存本地用户目录） */
export interface YunxiaoSettings {
  token: string;
  organizationId: string;
  organizationName?: string;
  projectId: string;
  projectName?: string;
  /** 当前令牌所属用户（「我负责的」过滤的身份来源；自动识别或手动兜底）。 */
  currentUserId?: string;
  currentUserName?: string;
  /** 知识沉淀审核议题的目标项目（缺省用内置「知识库图谱」项目 id）。 */
  knowledgeBaseProjectId?: string;
}

export const EMPTY_YUNXIAO_SETTINGS: YunxiaoSettings = {
  token: "",
  organizationId: "",
  projectId: "",
};

export interface AppSettings {
  claude_path: string;
  codex_path: string;
  dsh_path: string;
  dsh_profile: string;
  /** 是否启用该 Agent：禁用后不出现在「发起/运行任务」的 Agent 选择器中，但仍保留设置页入口 */
  claude_enabled: boolean;
  codex_enabled: boolean;
  dsh_enabled: boolean;
  send_shortcut: SendShortcut;
  terminal_shift_enter_newline: boolean;
  claude_force_default_tui: boolean;
  terminal_scrollback: number;
  /** 终端框选松手后自动把选区复制到剪贴板（copy-on-select） */
  terminal_copy_on_select: boolean;
  /** Windows：优先使用随包侧载的新版 ConPTY（重启后生效），其余平台无效果 */
  use_sideloaded_conpty: boolean;
  /** Agent 需要确认或任务完成/失败时发送 OS 系统通知（窗口未聚焦时） */
  system_notifications: boolean;
  /** 轻量 AI 辅助调用（任务命名/议题预填/汇总/知识沉淀/commit message）使用的模型；null = 跟随 Agent 默认 */
  claude_light_model: string | null;
  codex_light_model: string | null;
  /** 轻量 AI 辅助调用的思考深度；null = 跟随模型默认 */
  claude_light_reasoning_effort: string | null;
  codex_light_reasoning_effort: string | null;
  claude_model_catalog: AgentModelCatalog;
  codex_model_catalog: AgentModelCatalog;
  yunxiao: YunxiaoSettings;
}

/**
 * 后端加载完成前的占位默认值,与 app_settings.rs 各 default_* 保持一致。
 * 各面板统一引用此常量,新增字段只改这一处(组件内不要再写字面量)。
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  claude_path: "",
  codex_path: "",
  dsh_path: "",
  dsh_profile: "cc-tui",
  claude_enabled: true,
  codex_enabled: true,
  dsh_enabled: true,
  send_shortcut: DEFAULT_SEND_SHORTCUT,
  terminal_shift_enter_newline: DEFAULT_SHIFT_ENTER_NEWLINE,
  claude_force_default_tui: true,
  terminal_scrollback: DEFAULT_TERMINAL_SCROLLBACK,
  terminal_copy_on_select: false,
  use_sideloaded_conpty: true,
  system_notifications: true,
  claude_light_model: null,
  codex_light_model: null,
  claude_light_reasoning_effort: null,
  codex_light_reasoning_effort: null,
  claude_model_catalog: EMPTY_AGENT_MODEL_CATALOG,
  codex_model_catalog: EMPTY_AGENT_MODEL_CATALOG,
  yunxiao: EMPTY_YUNXIAO_SETTINGS,
};

export interface AgentVersions {
  claude_version: string;
  codex_version: string;
}

export type AgentKey = "claude" | "codex" | "dsh";

export type NavSection = "application" | "agents" | "community" | "about";

export interface AppSettingsNavItem {
  key: NavKey;
  labelKey: string;
  section: NavSection;
  icon?: LucideIcon;
  /** 覆盖图标描边颜色（默认 var(--text-secondary)） */
  iconColor?: string;
  /** 图标填充色（默认 "none"，传入颜色即为实心图标） */
  iconFill?: string;
  logo?: string;
  filePath?: string;
  lang?: string;
  /** 设置后点击该项不切换面板，而是用浏览器打开此外链 */
  url?: string;
}

export const APP_SETTINGS_CHANGED_EVENT = "nezha:app-settings-changed";
export const SKILL_HUB_CHANGED_EVENT = "nezha:skill-hub-changed";
export const OPEN_APP_SETTINGS_EVENT = "nezha:open-app-settings";

/**
 * `SKILL_HUB_CHANGED_EVENT` 可携带 `detail.projects`（来自后端 `set_skill_hub_path` 的完整列表），
 * App.tsx 收到后会把它作为权威列表替换前端 state，避免竞态覆盖 hub project。
 */
export interface SkillHubChangedDetail {
  projects?: unknown;
}
