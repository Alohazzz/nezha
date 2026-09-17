//! 知识沉淀自动回写：把通过**四层质量门**的知识候选写入项目配置绑定的知识图谱
//! 模块卡片，并 git 提交推送，替代「知识库负责人手工更新模块卡片」这最后一公里。
//!
//! 设计依据：`docs/proposals/knowledge-auto-sedimentation-v2.md` §5。
//! 核心原则是**确定性的事不交给 LLM**：
//! - L0 结构（不调 LLM）：字段完整、confidence=confirmed、模块/section 合法、目标卡片存在。
//! - L1 依据核验（不调 LLM）：evidence 声称的文件必须真实存在，行号在范围内，
//!   内容里反引号标注的符号能在依据中定位。见 [`crate::knowledge_gate::verify_evidence`]。
//! - L2 去重（不调 LLM）：规范化后相等即判重（击穿反引号 / 空白 / 日期 / 来源标注差异）；
//!   字符 bigram 只用于检索可疑条目，不单独裁定重复。
//! - L3 语义（一次 LLM 调用 × 2）：内联相关既有条目与 section 清单，
//!   判定 duplicate/conflict/distinct，**两次独立运行一致才放行**。
//!
//! 取向是「宁缺毋滥」：任一层不确定都倒向拒绝，拒绝理由分层可见（`item.layer`）。
//! 门本身的失败（超时 / 输出不可解析）按**逐条降级**处理，不再整批报错丢弃知识。
//! 只增不改：在对应 section 末尾追加「日期 + 置信度 + 内容 + 依据」，保留既有内容。

use crate::knowledge_gate::{
    self, EvidenceKind, ExistingEntry, GateContext, GateInput, GateVerdict,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// 前端传入的知识沉淀候选（与 KnowledgeSuggestion 对齐，camelCase）。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidate {
    pub module: String,
    pub section: String,
    pub content: String,
    pub evidence: String,
    pub confidence: String,
    /// 候选的标题建议。写入格式不使用它、去重判定也不依赖它（提案 §6.5），
    /// 但产出契约允许 agent 携带，故保留字段以免反序列化失败。
    #[serde(default)]
    #[allow(dead_code)]
    pub suggested_title: String,
    #[serde(default)]
    pub knowledge_graph_id: String,
}

/// 单条候选的回写结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWritebackItem {
    pub index: usize,
    pub module: String,
    pub section: String,
    pub passed: bool,
    pub written: bool,
    pub reason: String,
    /// 判定发生的层次：`L0` 结构 / `L1` 依据 / `L2` 去重 / `L3` 语义 / `write` 写入。
    /// 供拒因分层统计（提案 §9.2）。
    pub layer: String,
}

/// 一次提交的整体回写结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWritebackResult {
    pub items: Vec<KnowledgeWritebackItem>,
    pub all_passed: bool,
    pub written_count: usize,
    pub commit: Option<String>,
    /// 本次是否补推了此前失败留下的本地提交（重试语义的可见性，§8.4）。
    pub pushed_pending: bool,
}

/// 项目可选的一个知识图谱目标。目录名是稳定 ID；展示名优先取 SKILL.md 后的首个 H1。
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeTarget {
    pub id: String,
    pub name: String,
    pub adapter: String,
    pub graph_dir: String,
    pub skill_dir: String,
    pub data_dir: String,
    pub ready: bool,
    pub scan_available: bool,
}

#[derive(serde::Deserialize)]
struct GraphManifest {
    id: String,
    name: String,
    adapter: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGraphAdapter {
    pub id: String,
    pub name: String,
}

/// 新建模块卡片的通用模板；`<module>` 占位符在创建卡片时会被替换为模块名。
/// 与知识图谱技能的 module-card-guide.md 对齐，含「UI 界面 / 入口」节点。
const MODULE_CARD_TEMPLATE: &str = "# <module>\n\n## 定位\n\n## 职责\n\n## 关键实体 / 数据表\n\n## 依赖与相关模块\n\n## 业务规则 / 已知坑\n\n## UI 界面 / 入口\n\n## 验证记录\n";

#[tauri::command]
pub async fn list_knowledge_graph_adapters() -> Result<Vec<KnowledgeGraphAdapter>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<KnowledgeGraphAdapter>, String> {
        let hub = crate::skills::configured_hub_path()
            .ok_or_else(|| "技能库未配置，无法读取图谱适配器".to_string())?;
        let root = generic_skill_dir(Path::new(&hub)).join("adapters");
        if !root.is_dir() {
            return Ok(Vec::new());
        }
        let mut adapters = Vec::new();
        for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if path.extension().and_then(|value| value.to_str()) == Some("py") && id != "__init__" {
                adapters.push(KnowledgeGraphAdapter {
                    id: id.to_string(),
                    name: id.to_uppercase(),
                });
            }
        }
        adapters.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(adapters)
    })
    .await
    .map_err(|e| format!("读取图谱适配器线程错误: {e}"))?
}

static GRAPH_WRITE_LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    OnceLock::new();

/// 当前**正在**执行知识图谱写入（含 git 提交 / 推送）的数量。
/// hub 定时同步据此避让：写入期间拉取可能与本地提交互相干扰。
static GRAPH_WRITE_ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// 是否有知识图谱写入正在进行。供 hub 定时同步避让，不阻塞调用方。
pub(crate) fn knowledge_write_in_progress() -> bool {
    GRAPH_WRITE_ACTIVE.load(Ordering::SeqCst) > 0
}

/// 当前写入计数。仅供测试断言精确值（生产代码请用 [`knowledge_write_in_progress`]）。
#[cfg(test)]
pub(crate) fn graph_write_active_count() -> usize {
    GRAPH_WRITE_ACTIVE.load(Ordering::SeqCst)
}

/// 持锁守卫：计数在获取后 +1、释放时 -1，供 [`knowledge_write_in_progress`] 观测。
pub(crate) struct GraphWriteGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
}

impl Drop for GraphWriteGuard {
    fn drop(&mut self) {
        GRAPH_WRITE_ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 取得某图谱的写锁。同一图谱的写入被串行化；不同图谱可并发。
/// 计数在**拿到锁之后**才 +1，因此排队等待的调用方不会被算作「正在写入」。
pub(crate) async fn lock_graph(graph_id: &str) -> GraphWriteGuard {
    let locks = GRAPH_WRITE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let lock = locks
        .lock()
        .expect("graph write locks poisoned")
        .entry(graph_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let guard = lock.lock_owned().await;
    GRAPH_WRITE_ACTIVE.fetch_add(1, Ordering::SeqCst);
    GraphWriteGuard { _guard: guard }
}

/// 一次性取出「哪些待写模块卡片有未提交人工修改」。整批一次 `git status`，
/// 避免按候选逐条调用产生 N 个子进程。命令失败时**保守地视为全部脏**（逐条降级为不写入），
/// 而不是整批报错——否则已经付出的模型判定会被白费掉。
async fn dirty_module_cards(
    graph: &KnowledgeTarget,
    modules: &[String],
) -> Result<HashSet<String>, String> {
    let mut pathspecs: Vec<String> = Vec::new();
    for module in modules {
        let path = module_card_path(graph, module)?;
        let rel = path
            .strip_prefix(&graph.graph_dir)
            .map_err(|_| "模块卡片路径越界".to_string())?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !pathspecs.contains(&rel) {
            pathspecs.push(rel);
        }
    }
    if pathspecs.is_empty() {
        return Ok(HashSet::new());
    }
    // `core.quotepath` 默认会对非 ASCII 路径做 C 转义（`"data/modules/æ.md"`），
    // 那样解析出的模块名是垃圾、dirty 判定落空，卡片会被**静默覆盖**——正是本层要防的事。
    let mut args: Vec<String> = vec![
        "-c".into(),
        "core.quotepath=false".into(),
        "status".into(),
        "--porcelain".into(),
        "--".into(),
    ];
    args.extend(pathspecs);
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        args,
        std::time::Duration::from_secs(15),
    )
    .await?;
    if !result.status.success() {
        eprintln!(
            "[knowledge] git status 失败，按全部未提交处理：{}",
            String::from_utf8_lossy(&result.stderr).trim()
        );
        return Ok(modules.iter().cloned().collect());
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    let mut dirty: HashSet<String> = HashSet::new();
    for line in stdout.lines() {
        // porcelain 行：`XY path`（path 可能含空格，取状态字段之后的整段）。
        let Some(rest) = line.get(3..) else { continue };
        let norm = rest.trim().trim_matches('"').replace('\\', "/");
        if let Some(name) = norm.rsplit('/').next() {
            if let Some(module) = name.strip_suffix(".md") {
                dirty.insert(module.to_string());
            }
        }
    }
    Ok(dirty)
}

/// L3 语义判定单次调用的超时。内联上下文后实测 5–20 s，120 s 留足余量。
/// 超时按**逐条降级**处理（不整批报错），见 [`knowledge_auto_writeback`]。
const QUALITY_GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// 单次质量门提示词的字数上限。Windows `CreateProcess` 的命令行上限是 32767 字符，
/// 而提示词走 argv，因此必须显式分批，避免多余候选静默落入 fail-closed。
const MAX_GATE_PROMPT_CHARS: usize = 20_000;

/// 内联进质量门的既有条目条数上限（按 bigram 覆盖率取最相近的若干条）。
const RELATED_ENTRY_K: usize = 8;
/// 内联既有条目的相关度下限：低于该值的条目不值得占用提示词预算。
const RELATED_ENTRY_FLOOR: f64 = 0.30;
/// 内联条目总数硬上限，防止 related 集合本身撑爆每个分块的预算。
const RELATED_ENTRY_MAX: usize = 40;
/// 单条内联既有条目的字数上限（含截断符）。实测卡片条目最长约 480 字符，
/// 取 400 既保留语义又给 argv 上限留出余量。
const RELATED_ENTRY_MAX_CHARS: usize = 400;
/// 送入质量门的单字段长度上限，避免超长候选把提示词撑爆。
const GATE_FIELD_MAX_CHARS: usize = 4000;
/// 参与 L2 比对的条目的最短归一化长度；过短片段不参与比对。
const MIN_COMPARABLE_CHARS: usize = 6;

pub(crate) fn knowledge_graphs_root(hub_path: &Path) -> PathBuf {
    hub_path.join("knowledge-graphs")
}

fn generic_skill_dir(hub_path: &Path) -> PathBuf {
    hub_path.join("knowledge-graph")
}

/// 列出 graph.toml 声明的所有项目图谱；SkillHub 只是存储容器，不做 HIS 默认兜底。
pub(crate) fn list_knowledge_targets_internal() -> Result<Vec<KnowledgeTarget>, String> {
    let hub = crate::skills::configured_hub_path()
        .ok_or_else(|| "技能库未配置，无法选择知识库".to_string())?;
    let hub_path = PathBuf::from(&hub);
    if !hub_path.is_dir() {
        return Err("技能库路径不存在，无法选择知识库".to_string());
    }

    let graphs_root = knowledge_graphs_root(&hub_path);
    if !graphs_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut targets = Vec::new();
    for entry in std::fs::read_dir(&graphs_root).map_err(|e| format!("读取知识图谱失败: {e}"))?
    {
        let entry = entry.map_err(|e| format!("读取技能库条目失败: {e}"))?;
        let path = entry.path();
        let manifest_path = path.join("graph.toml");
        if !path.is_dir() || !manifest_path.is_file() {
            continue;
        }
        let manifest: GraphManifest = toml::from_str(
            &std::fs::read_to_string(&manifest_path)
                .map_err(|e| format!("读取 {} 失败: {e}", manifest_path.display()))?,
        )
        .map_err(|e| format!("解析 {} 失败: {e}", manifest_path.display()))?;
        let id = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "技能库包含无法表示的目录名".to_string())?
            .to_string();
        if manifest.id != id {
            continue;
        }
        let data_dir = path.join("data");
        let ready = data_dir.join("modules").is_dir() && generic_skill_dir(&hub_path).is_dir();
        let scan_available = ready
            && generic_skill_dir(&hub_path)
                .join("adapters")
                .join(format!("{}.py", manifest.adapter))
                .is_file();
        targets.push(KnowledgeTarget {
            id: manifest.id,
            name: manifest.name,
            adapter: manifest.adapter,
            graph_dir: path.to_string_lossy().into_owned(),
            skill_dir: generic_skill_dir(&hub_path).to_string_lossy().into_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            ready,
            scan_available,
        });
    }
    targets.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(targets)
}

/// 任务完成后自动处理知识沉淀（best-effort，superseded 由日志与事件体现）。
///
/// 决策（提案 §8.1）：任务完成即自动处理，无手动按钮。前置条件是三条**都已成立**：
/// - 总开关开启（`settings.knowledge.enabled`，默认开）
/// - 项目绑定了图谱（`graph_id` 非空；未绑定项目连产出契约都不注入）
/// - 该任务的会话内产物存在（缺失 = 「漏了」，由 `generate_knowledge_sedimentation` 报错）
///
/// 本函数**立即返回**，实际工作在后台任务里跑（一次沉淀含最多两次模型调用，
/// 不能拖住 PTY 退出收尾路径）。结果通过 `knowledge-sedimentation` 事件上报。
pub fn spawn_auto_sedimentation(
    app: tauri::AppHandle,
    task_id: String,
    real_project_path: String,
    agent: String,
) {
    if !crate::app_settings::load_settings_internal().knowledge.enabled {
        return; // 总开关关闭：不跑沉淀，也不要求产出
    }
    tauri::async_runtime::spawn(async move {
        let result = run_auto_sedimentation(&task_id, &real_project_path, &agent).await;
        match result {
            Ok(outcome) => {
                let _ = app.emit(
                    "knowledge-sedimentation",
                    serde_json::json!({
                        "taskId": task_id,
                        "status": "ok",
                        "written": outcome.written_count,
                        "pushedPending": outcome.pushed_pending,
                        "items": outcome.items,
                        "commit": outcome.commit,
                    }),
                );
            }
            Err(error) => {
                eprintln!("[knowledge] 自动沉淀未完成：{error}");
                let _ = app.emit(
                    "knowledge-sedimentation",
                    serde_json::json!({
                        "taskId": task_id,
                        "status": "failed",
                        "error": error,
                    }),
                );
            }
        }
    });
}

/// 跑一次自动沉淀：读会话内候选 → 分层门 → 写入 + 提交推送。
async fn run_auto_sedimentation(
    task_id: &str,
    real_project_path: &str,
    agent: &str,
) -> Result<KnowledgeWritebackResult, String> {
    // 未绑定图谱的项目直接跳过（不是错误——产出契约本就没注入）。
    let target = match resolve_knowledge_target(real_project_path.to_string()).await {
        Ok(target) => target,
        Err(_) => return Ok(empty_writeback_result()),
    };
    // 复用同一套产出契约解析（含 skipped / 图谱兜底 / 缺失判定）。
    let draft = crate::drafts::read_draft_file(real_project_path, task_id, "knowledge.json")
        .map_err(|e| format!("读取知识沉淀产物失败: {e}"))?
        .filter(|raw| !raw.trim().is_empty());
    let Some(raw) = draft else {
        // 缺失 = 「漏了」：如实报错，不静默（这是「忘了」与「确实没有」的区分点）。
        return Err(format!(
            "本次任务未产出知识沉淀产物（.nezha/drafts/{task_id}/knowledge.json）"
        ));
    };
    let parsed = crate::agent_assist::parse_knowledge_draft(&raw, &target.id)?;
    if parsed.is_skipped() {
        return Ok(empty_writeback_result());
    }
    let candidates: Vec<KnowledgeCandidate> = parsed
        .candidates()
        .iter()
        .map(|s| KnowledgeCandidate {
            module: s.module.clone(),
            section: s.section.clone(),
            content: s.content.clone(),
            evidence: s.evidence.clone(),
            confidence: s.confidence.clone(),
            suggested_title: s.suggested_title.clone(),
            knowledge_graph_id: s.knowledge_graph_id.clone(),
        })
        .collect();
    if candidates.is_empty() {
        return Ok(empty_writeback_result());
    }
    // agent 取自该任务本身的 agent（不是「默认 agent」——任务可能用非默认的那个）。
    let agent = if agent == "claude" || agent == "codex" {
        agent.to_string()
    } else {
        "claude".to_string()
    };
    knowledge_auto_writeback(real_project_path.to_string(), candidates, agent).await
}

fn empty_writeback_result() -> KnowledgeWritebackResult {
    KnowledgeWritebackResult {
        items: Vec::new(),
        all_passed: true,
        written_count: 0,
        commit: None,
        pushed_pending: false,
    }
}

/// 供 PTY 启动时注入给 agent 的图谱环境变量（best-effort，失败返回空）。
///
/// 图谱身份由 Nezha 从**主项目**配置解析后下发，因此在 worktree 中
/// （`.nezha/config.toml` 被 gitignore、那里没有该文件）agent 也能拿到图谱位置。
/// 见设计规格 ticket 10。
///
/// 只读两个小配置文件（项目配置 + hub 配置）并做路径拼接，**不扫描图谱目录**，
/// 因此可以在 spawn 路径上直接调用。
pub(crate) fn knowledge_env_for_project(real_project_path: &str) -> Vec<(String, String)> {
    let Ok(config) = crate::config::read_project_config(real_project_path.to_string()) else {
        return Vec::new();
    };
    let graph_id = config.knowledge.graph_id.trim();
    if graph_id.is_empty() {
        return Vec::new(); // 未绑定图谱：不注入，agent 行为与原来一致
    }
    let Some(hub) = crate::skills::configured_hub_path() else {
        return Vec::new();
    };
    let data_dir = knowledge_graphs_root(Path::new(&hub))
        .join(graph_id)
        .join("data");
    vec![
        ("NEZHA_KNOWLEDGE_GRAPH_ID".to_string(), graph_id.to_string()),
        (
            "NEZHA_KNOWLEDGE_GRAPH_DIR".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ),
    ]
}

/// 读取项目配置中的知识库目标。未配置或目标不存在时报错，不回退 HIS。
pub(crate) fn resolve_knowledge_target_internal(
    project_path: &str,
) -> Result<KnowledgeTarget, String> {
    let config = crate::config::read_project_config(project_path.to_string())?;
    let target_id = config.knowledge.graph_id.trim();
    if target_id.is_empty() {
        return Err("当前项目未配置知识库，无法沉淀或回写".to_string());
    }
    list_knowledge_targets_internal()?
        .into_iter()
        .find(|target| target.id == target_id)
        .ok_or_else(|| format!("知识库不可用：{target_id}（请在项目设置中重新选择）"))
}

pub(crate) async fn resolve_knowledge_target(
    project_path: String,
) -> Result<KnowledgeTarget, String> {
    tokio::task::spawn_blocking(move || resolve_knowledge_target_internal(&project_path))
        .await
        .map_err(|e| format!("读取知识库配置线程错误: {e}"))?
}

#[tauri::command]
pub async fn list_knowledge_targets() -> Result<Vec<KnowledgeTarget>, String> {
    tokio::task::spawn_blocking(list_knowledge_targets_internal)
        .await
        .map_err(|e| format!("扫描知识库线程错误: {e}"))?
}

fn graph_by_id(graph_id: &str) -> Result<KnowledgeTarget, String> {
    list_knowledge_targets_internal()?
        .into_iter()
        .find(|g| g.id == graph_id)
        .ok_or_else(|| format!("知识图谱不存在：{graph_id}"))
}

async fn graph_by_id_async(graph_id: String) -> Result<KnowledgeTarget, String> {
    tokio::task::spawn_blocking(move || graph_by_id(&graph_id))
        .await
        .map_err(|e| format!("解析知识图谱线程错误: {e}"))?
}

fn graph_id_is_safe(v: &str) -> bool {
    (2..=64).contains(&v.len())
        && v.chars()
            .enumerate()
            .all(|(i, c)| c.is_ascii_alphanumeric() || (i > 0 && (c == '-' || c == '_')))
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeModuleCard {
    pub module: String,
    pub content: String,
    pub modified: bool,
}

#[tauri::command]
pub async fn create_knowledge_graph(
    project_path: String,
    graph_id: String,
    name: String,
    adapter: String,
) -> Result<KnowledgeTarget, String> {
    tokio::task::spawn_blocking(move || -> Result<KnowledgeTarget, String> {
        if !graph_id_is_safe(&graph_id) { return Err("图谱 ID 不合法".into()); }
        if name.trim().is_empty() || name.contains(['"', '\n', '\r', '\\']) { return Err("图谱名称不能为空".into()); }
        if adapter.is_empty() || adapter.contains(['/', '\\', ':']) { return Err("图谱适配器不合法".into()); }
        let hub = PathBuf::from(crate::skills::configured_hub_path().ok_or("技能库未配置")?);
        let generic = hub.join("knowledge-graph");
        if !generic.join("adapters").join(format!("{adapter}.py")).is_file() { return Err(format!("适配器不存在：{adapter}")); }
        let graph_dir = hub.join("knowledge-graphs").join(&graph_id);
        if graph_dir.exists() { return Err(format!("图谱已存在：{graph_id}")); }
        let data = graph_dir.join("data");
        let io = |e: std::io::Error| e.to_string();
        // 注册图谱：只写 graph.toml 与空 data 目录并绑定项目配置。
        // 骨架（modules/_template.md/index.md/graph.json）交给「初始化骨架」生成，
        // 这样新建项目能走「创建图谱 → 初始化骨架」两步，初始化按钮不会因 ready=true 被隐藏。
        std::fs::create_dir_all(&data).map_err(io)?;
        std::fs::write(graph_dir.join("graph.toml"), format!("id = \"{graph_id}\"\nname = \"{}\"\nadapter = \"{adapter}\"\n", name.trim())).map_err(io)?;
        let mut config = crate::config::read_project_config(project_path.clone())?;
        config.knowledge.graph_id = graph_id.clone();
        crate::config::write_project_config(project_path, config)?;
        Ok(KnowledgeTarget { id: graph_id, name: name.trim().into(), adapter, graph_dir: graph_dir.to_string_lossy().into_owned(), skill_dir: generic.to_string_lossy().into_owned(), data_dir: data.to_string_lossy().into_owned(), ready: false, scan_available: false })
    }).await.map_err(|e| format!("创建图谱线程错误: {e}"))?
}

#[tauri::command]
pub async fn bind_knowledge_graph(
    project_path: String,
    graph_id: String,
) -> Result<KnowledgeTarget, String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    tokio::task::spawn_blocking(move || -> Result<KnowledgeTarget, String> {
        let mut config = crate::config::read_project_config(project_path.clone())?;
        config.knowledge.graph_id = graph.id.clone();
        crate::config::write_project_config(project_path, config)?;
        Ok(graph)
    })
    .await
    .map_err(|e| format!("绑定图谱线程错误: {e}"))?
}

#[tauri::command]
pub async fn unbind_knowledge_graph(project_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut config = crate::config::read_project_config(project_path.clone())?;
        config.knowledge.graph_id = String::new();
        crate::config::write_project_config(project_path, config)
    })
    .await
    .map_err(|e| format!("解绑图谱线程错误: {e}"))?
}

#[tauri::command]
pub async fn initialize_knowledge_graph(
    project_path: String,
    graph_id: String,
) -> Result<KnowledgeTarget, String> {
    tokio::task::spawn_blocking(move || -> Result<KnowledgeTarget, String> {
        let mut graph = graph_by_id(&graph_id)?;
        let data = PathBuf::from(&graph.data_dir);
        let modules = data.join("modules");
        let io = |e: std::io::Error| e.to_string();
        std::fs::create_dir_all(&modules).map_err(io)?;
        let template = data.join("_template.md");
        if !template.exists() {
            std::fs::write(&template, MODULE_CARD_TEMPLATE).map_err(io)?;
        }
        let index = data.join("index.md");
        if !index.exists() {
            std::fs::write(&index, "# Knowledge Graph\n\n## Modules\n\n| Module | Card |\n|---|---|\n").map_err(io)?;
        }
        let machine_graph = data.join("graph.json");
        if !machine_graph.exists() {
            std::fs::write(&machine_graph, "{\n  \"modules\": [],\n  \"dependencies\": []\n}\n").map_err(io)?;
        }
        graph.ready = true;
        let mut config = crate::config::read_project_config(project_path.clone())?;
        config.knowledge.graph_id = graph.id.clone();
        crate::config::write_project_config(project_path, config)?;
        Ok(graph)
    })
    .await
    .map_err(|e| format!("初始化图谱线程错误: {e}"))?
}

#[tauri::command]
pub async fn scan_knowledge_graph(project_path: String) -> Result<String, String> {
    let graph = resolve_knowledge_target(project_path.clone()).await?;
    let bootstrap = Path::new(&graph.skill_dir).join("scripts/bootstrap.py");
    let adapter = Path::new(&graph.skill_dir)
        .join("adapters")
        .join(format!("{}.py", graph.adapter));
    if !bootstrap.is_file() || !adapter.is_file() {
        return Err("图谱初始化脚本或适配器不可用".into());
    }
    let mut cmd = tokio::process::Command::new("python");
    cmd.arg(bootstrap)
        .arg("--adapter")
        .arg(&graph.adapter)
        .arg("--repo")
        .arg(&project_path)
        .arg("--data-dir")
        .arg(&graph.data_dir)
        .arg("--mode")
        .arg("scan");
    crate::subprocess::configure_background_tokio_command(&mut cmd);
    let output = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "知识图谱扫描超时".to_string())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "扫描失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn module_card_path(graph: &KnowledgeTarget, module: &str) -> Result<PathBuf, String> {
    if !module_is_safe(module) {
        return Err(format!("模块名不合法：{module}"));
    }
    Ok(Path::new(&graph.data_dir)
        .join("modules")
        .join(format!("{module}.md")))
}

#[tauri::command]
pub async fn list_knowledge_cards(graph_id: String) -> Result<Vec<KnowledgeModuleCard>, String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    tokio::task::spawn_blocking(move || -> Result<Vec<KnowledgeModuleCard>, String> {
        let dir = Path::new(&graph.data_dir).join("modules");
        let mut cards = Vec::new();
        // 图谱尚未「初始化骨架」时没有 data/modules 目录，按空列表返回，避免前端报错。
        if !dir.is_dir() {
            return Ok(cards);
        }
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|v| v.to_str()) != Some("md") {
                continue;
            }
            let Some(module) = path.file_stem().and_then(|v| v.to_str()) else {
                continue;
            };
            if module_is_safe(module) {
                let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                cards.push(KnowledgeModuleCard {
                    module: module.into(),
                    content,
                    modified: false,
                });
            }
        }
        cards.sort_by(|a, b| a.module.to_lowercase().cmp(&b.module.to_lowercase()));
        Ok(cards)
    })
    .await
    .map_err(|e| format!("读取模块卡片线程错误: {e}"))?
}

/// 读取当前项目绑定知识库的某张模块卡片全文（用于在主窗体以 Markdown 打开）。
/// 路径由绑定图谱的 data_dir + 校验过的 module 推导，不接受任意路径。
#[tauri::command]
pub async fn read_knowledge_card_content(
    project_path: String,
    module: String,
) -> Result<String, String> {
    let target = resolve_knowledge_target(project_path).await?;
    let path = module_card_path(&target, &module)?;
    tokio::task::spawn_blocking(move || std::fs::read_to_string(path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("读取知识库卡片线程错误: {e}"))?
}

/// 列出知识库仓库中相对 HEAD 有未提交改动的模块卡片名（用于「发布」按钮）。
/// 只扫描 `data/modules/*.md`，一次性 `git status --porcelain` 解析，避免逐卡查询。
#[tauri::command]
pub async fn list_modified_knowledge_cards(graph_id: String) -> Result<Vec<String>, String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        vec![
            "status".into(),
            "--porcelain".into(),
            "--".into(),
            "data/modules".into(),
        ],
        std::time::Duration::from_secs(10),
    )
    .await?;
    if !result.status.success() {
        return Err(format!(
            "读取知识库变更失败: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&result.stdout);
    let mut modules = Vec::new();
    for line in stdout.lines() {
        // porcelain 行：`XY path`（XY 为状态标志，path 可能含空格，取第二个字段即可）。
        let mut parts = line.split_whitespace();
        let _status = parts.next();
        let Some(path) = parts.next() else { continue };
        let norm = path.replace('\\', "/");
        let Some(idx) = norm.rfind("data/modules/") else { continue };
        let rest = &norm[idx + "data/modules/".len()..];
        let Some(module) = rest.strip_suffix(".md") else { continue };
        if module_is_safe(module) && !modules.contains(&module.to_string()) {
            modules.push(module.to_string());
        }
    }
    modules.sort();
    Ok(modules)
}

#[tauri::command]
pub async fn save_knowledge_card(
    graph_id: String,
    module: String,
    content: String,
) -> Result<(), String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let path = module_card_path(&graph, &module)?;
    tokio::task::spawn_blocking(move || std::fs::write(path, content).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("保存模块卡片线程错误: {e}"))?
}

#[tauri::command]
pub async fn rename_knowledge_card(
    graph_id: String,
    old_module: String,
    new_module: String,
) -> Result<(), String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let from = module_card_path(&graph, &old_module)?;
    let to = module_card_path(&graph, &new_module)?;
    tokio::task::spawn_blocking(move || {
        if !from.is_file() {
            return Err("模块卡片不存在".into());
        }
        if to.exists() {
            return Err("目标模块卡片已存在".into());
        }
        std::fs::rename(from, to).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("重命名模块卡片线程错误: {e}"))?
}

#[tauri::command]
pub async fn delete_knowledge_card(graph_id: String, module: String) -> Result<(), String> {
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let path = module_card_path(&graph, &module)?;
    tokio::task::spawn_blocking(move || {
        if !path.is_file() {
            return Err("模块卡片不存在".into());
        }
        std::fs::remove_file(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("删除模块卡片线程错误: {e}"))?
}

#[tauri::command]
pub async fn publish_knowledge_changes(
    graph_id: String,
    paths: Vec<String>,
    message: String,
) -> Result<String, String> {
    if message.trim().is_empty() || paths.is_empty() {
        return Err("提交内容和路径不能为空".into());
    }
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let _guard = lock_graph(&graph.id).await;
    let _hub_git_guard = crate::skills::lock_hub_git().await;
    let graph_dir = PathBuf::from(&graph.graph_dir);
    let mut absolute = Vec::new();
    for path_text in paths {
        let rel = Path::new(&path_text);
        if rel.is_absolute() || path_text.contains("..") {
            return Err(format!("路径不合法：{path_text}"));
        }
        let path = graph_dir.join(rel);
        if !path.is_file() {
            let tracked = crate::git::run_git_with_timeout(
                graph.graph_dir.clone(),
                vec![
                    "ls-files".into(),
                    "--".into(),
                    path.to_string_lossy().into_owned(),
                ],
                std::time::Duration::from_secs(10),
            )
            .await?;
            if String::from_utf8_lossy(&tracked.stdout).trim().is_empty() {
                return Err(format!("图谱变更不存在：{path_text}"));
            }
        }
        absolute.push(path.to_string_lossy().replace('\\', "/"));
    }
    let mut add = vec!["add".to_string(), "--".to_string()];
    add.extend(absolute);
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        add,
        std::time::Duration::from_secs(30),
    )
    .await?;
    if !result.status.success() {
        return Err(format!(
            "git add 失败: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        vec!["commit".into(), "-m".into(), message],
        std::time::Duration::from_secs(30),
    )
    .await?;
    if !result.status.success() {
        return Err(format!(
            "git commit 失败: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        vec!["push".into()],
        std::time::Duration::from_secs(120),
    )
    .await?;
    if !result.status.success() {
        return Err(format!(
            "本地提交已保留，但推送失败: {}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok("已提交并推送".into())
}

/// section 标题归一化：去空白、`/` 归并为「与」，让候选的
/// 「关键实体与数据表」能命中文档里的「关键实体 / 数据表」标题。
fn normalize_section(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| if c == '/' { '与' } else { c })
        .collect()
}

/// 模块名只允许字母/数字/点/下划线/连字符，杜绝路径穿越。
fn module_is_safe(module: &str) -> bool {
    !module.is_empty()
        && module
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// 候选对应的模块卡片路径；调用方需先确认目标知识库可用。
/// 走 `data_dir`，与 [`module_card_path`] 保持同一来源，避免硬编码 `data`。
fn module_doc_path(target: &KnowledgeTarget, module: &str) -> PathBuf {
    Path::new(&target.data_dir)
        .join("modules")
        .join(format!("{module}.md"))
}

/// 不接受自动沉淀的 section：`定位` 由扫描生成（业务领域 / 代码路径 / 工程数），
/// 属结构性字段，写入会造成结构性漂移。见 docs/proposals/knowledge-sedimentation-contract-v2.md §3。
const NON_WRITABLE_SECTIONS: &[&str] = &["定位"];

fn is_non_writable_section(section: &str) -> bool {
    let target = normalize_section(section);
    NON_WRITABLE_SECTIONS
        .iter()
        .any(|blocked| normalize_section(blocked) == target)
}

/// 在模块文档中定位 section 标题行号（`## <标题>`），按归一化标题匹配。
fn find_section_heading(lines: &[&str], section: &str) -> Option<usize> {
    let target = normalize_section(section);
    lines.iter().enumerate().find_map(|(idx, line)| {
        let rest = line.strip_prefix("## ")?;
        (normalize_section(rest.trim()) == target).then_some(idx)
    })
}

/// 校验单个候选的结构合法性（L0 层，不调 LLM）。
/// 返回 `Ok(())` 或拒绝原因。内容重复与依据真伪分别由 L2 / L1 负责，不在这里判断。
fn validate_candidate(target: &KnowledgeTarget, candidate: &KnowledgeCandidate) -> Result<(), String> {
    if candidate.content.trim().is_empty() {
        return Err("内容为空".to_string());
    }
    if candidate.evidence.trim().is_empty() {
        return Err("缺少依据（evidence）".to_string());
    }
    if candidate.confidence != "confirmed" {
        return Err(format!(
            "置信度为 {}，仅 confirmed 可自动回写",
            candidate.confidence
        ));
    }
    if !module_is_safe(&candidate.module) {
        return Err(format!("模块名不合法：{}", candidate.module));
    }
    if candidate.section.trim().is_empty() {
        return Err("section 为空".to_string());
    }
    if is_non_writable_section(&candidate.section) {
        return Err(format!(
            "section「{}」由扫描生成，不接受自动沉淀；请改投 职责 / 业务规则与已知坑 等可写段",
            candidate.section.trim()
        ));
    }
    if candidate.knowledge_graph_id != target.id {
        return Err(format!(
            "候选绑定知识库不一致：{} ≠ {}",
            candidate.knowledge_graph_id, target.id
        ));
    }
    let doc = module_doc_path(target, &candidate.module);
    if !doc.is_file() {
        return Err(format!(
            "{}/data/modules/{}.md",
            target.id, candidate.module
        ));
    }
    let content = std::fs::read_to_string(&doc).map_err(|e| format!("读取模块卡片失败: {e}"))?;
    let lines: Vec<&str> = content.lines().collect();
    if find_section_heading(&lines, &candidate.section).is_none() {
        return Err(format!("模块卡片中找不到 section：{}", candidate.section));
    }
    Ok(())
}

/// 读取目标图谱全部模块卡片的知识条目，作为 L2 去重语料。
/// 图谱规模很小（实测 126 张卡片 / 289 KB），整图读取在毫秒级。
fn load_graph_entries(target: &KnowledgeTarget) -> Result<Vec<ExistingEntry>, String> {
    let dir = Path::new(&target.data_dir).join("modules");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)
        .map_err(|e| format!("读取图谱模块目录失败: {e}"))?
        .flatten()
    {
        let path = item.path();
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            continue;
        }
        let Some(module) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        if !module_is_safe(module) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in knowledge_gate::extract_card_entries(&text) {
            let entry = ExistingEntry::new(module, line);
            // 过短的片段（表头残留、单字列表项）不参与比对，避免噪声误判。
            if entry.normalized.chars().count() < MIN_COMPARABLE_CHARS {
                continue;
            }
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// 一条候选在确定性层（L1 + L2）的结论。
struct DeterministicVerdict {
    /// `None` 表示通过，进入 L3；`Some((layer, reason))` 表示拒绝。
    rejection: Option<(String, String)>,
    /// 依据核验的结论说明（即使通过也保留，便于追溯）。
    note: String,
}

/// L1 依据核验 + L2 去重（含批内去重）。纯文件 I/O，由 `spawn_blocking` 调用。
fn run_deterministic_layers(
    project_root: &Path,
    candidates: &[KnowledgeCandidate],
    indices: &[usize],
    entries: &[ExistingEntry],
) -> Vec<(usize, DeterministicVerdict)> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    // 一个解析器复用一个（懒构建的）项目文件索引，避免逐条重建。
    let resolver = knowledge_gate::EvidenceResolver::new(project_root);
    let mut out = Vec::with_capacity(indices.len());
    for &index in indices {
        let candidate = &candidates[index];
        let verdict = match resolver.verify(&candidate.evidence, &candidate.content) {
            Err(reason) => DeterministicVerdict {
                rejection: Some(("L1".to_string(), reason)),
                note: String::new(),
            },
            Ok(kind) => {
                let note = evidence_note(&kind);
                let normalized = knowledge_gate::normalize_knowledge_text(&candidate.content);
                if normalized.is_empty() {
                    // 纯标点 / 纯格式字符：规范化后无实质内容，既无法与既有条目比对，
                    // 也没有知识价值（否则会绕过 L2 直接写入卡片）。
                    DeterministicVerdict {
                        rejection: Some((
                            "L2".to_string(),
                            "内容规范化后为空，无可比对的知识实质".to_string(),
                        )),
                        note,
                    }
                } else if let Some(duplicate) = knowledge_gate::find_exact_duplicate(entries, &normalized) {
                    DeterministicVerdict {
                        rejection: Some((
                            "L2".to_string(),
                            format!(
                                "内容已存在于模块 {}（规范化后与既有条目相同，重复沉淀）",
                                duplicate.module
                            ),
                        )),
                        note,
                    }
                } else if let Some(previous) = seen.get(&normalized) {
                    DeterministicVerdict {
                        rejection: Some((
                            "L2".to_string(),
                            format!("与本批第 {previous} 条重复（规范化后相同）"),
                        )),
                        note,
                    }
                } else {
                    seen.insert(normalized, index);
                    DeterministicVerdict {
                        rejection: None,
                        note,
                    }
                }
            }
        };
        out.push((index, verdict));
    }
    out
}

fn evidence_note(kind: &EvidenceKind) -> String {
    match kind {
        EvidenceKind::File { path } => format!("依据文件已核验：{path}"),
        EvidenceKind::Location { detail } => format!("依据位置无法逐文件核验：{detail}"),
        EvidenceKind::UserConfirmed => "依据为用户确认，无法机器核验".to_string(),
    }
}

/// 写前把本地未推送的提交补推上去，并在落后远端时先做 `--ff-only` 拉取。
///
/// 返回「是否发生了补推」。任何一步失败都**不阻断**本次沉淀：
/// 本次写入仍会照常提交，推送失败由调用方按可重试错误处理（本地提交保留）。
async fn push_pending_commits(target: &KnowledgeTarget) -> Result<bool, String> {
    // 先 fetch：`@{u}` 是**本地**的远端跟踪引用，不 fetch 就无法知道远端已前进
    // （实测：上游有别人的新提交时，本地不 fetch 看到的仍是 ahead=1 / behind=0）。
    // fetch 很便宜（实测一次约 2 s），且这一步的失败不阻断——后续 pull/push 会照实报错。
    let fetched = crate::git::run_git_with_timeout(
        target.graph_dir.clone(),
        vec!["fetch".into(), "origin".into()],
        std::time::Duration::from_secs(120),
    )
    .await?;
    if !fetched.status.success() {
        eprintln!(
            "[knowledge] 写前 fetch 失败（继续尝试提交推送）: {}",
            String::from_utf8_lossy(&fetched.stderr).trim()
        );
    }

    // 落后远端就先 ff-only 拉，降低非快进 push 的概率。
    // 分叉（既领先又落后）时 pull 会失败——那是需要人工处理的状态，此时**不硬写**。
    let behind = crate::git::run_git_with_timeout(
        target.graph_dir.clone(),
        vec![
            "rev-list".into(),
            "--count".into(),
            "HEAD..@{u}".into(),
        ],
        std::time::Duration::from_secs(15),
    )
    .await?;
    if behind.status.success() {
        let count = String::from_utf8_lossy(&behind.stdout).trim().to_string();
        if count != "0" {
            let pull = crate::git::run_git_with_timeout(
                target.graph_dir.clone(),
                vec![
                    "pull".into(),
                    "--no-rebase".into(),
                    "--ff-only".into(),
                ],
                std::time::Duration::from_secs(120),
            )
            .await?;
            if !pull.status.success() {
                return Err(format!(
                    "图谱仓库落后远端且无法快进（可能有本地改动或已分叉），已停止写入以避免损坏仓库：{}",
                    String::from_utf8_lossy(&pull.stderr).trim()
                ));
            }
        }
    }

    // 补推本地未推送的提交（上一次 push 失败留下的）。
    let ahead = crate::git::run_git_with_timeout(
        target.graph_dir.clone(),
        vec!["rev-list".into(), "--count".into(), "@{u}..HEAD".into()],
        std::time::Duration::from_secs(15),
    )
    .await?;
    if !ahead.status.success() {
        return Ok(false); // 没有 upstream 等：交给后续 push 报错，不在这里拦截
    }
    let pending = String::from_utf8_lossy(&ahead.stdout).trim().to_string();
    if pending == "0" {
        return Ok(false);
    }
    let push = crate::git::run_git_with_timeout(
        target.graph_dir.clone(),
        vec!["push".into()],
        std::time::Duration::from_secs(120),
    )
    .await?;
    if !push.status.success() {
        return Err(format!(
            "补推未推送的本地提交失败: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }
    Ok(true)
}

/// 生成本次沉淀的溯源标记：`<图谱>@<UTC 时间戳>.<短随机段>`。
/// 与提交信息里的 `kg=<token>` 对应，二者可在 `git log -S` / `git log --grep` 中互相定位。
///
/// 带上随机后缀：毫秒级时间戳在同一毫秒内调用会撞车（实测两次连续调用相同），
/// 而 token 的用途正是区分**不同批次**，撞 token 会让回滚按批定位失效。
fn sediment_trace_token(graph_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    format!(
        "{}@{}.{}",
        graph_id,
        chrono::DateTime::from_timestamp(
            (nanos / 1_000_000_000) as i64,
            (nanos % 1_000_000_000) as u32
        )
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y%m%dT%H%M%S%.3fZ"),
        &suffix[..8]
    )
}

/// 在 section 末尾追加一条结构化知识块（只增不改），返回新文件内容。
///
/// section 在 L0 已校验过，但校验与写入之间隔着 L1~L3（可能数分钟、两次模型调用）；
/// 期间卡片可能被 hub 拉取或人工编辑改动，因此这里必须**重新定位并优雅失败**，
/// 不能靠 `expect` 在 async 命令里崩溃。
fn append_entry(
    content: &str,
    section: &str,
    candidate: &KnowledgeCandidate,
    trace: &str,
) -> Result<String, String> {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    if !content.ends_with('\n') {
        lines.push(String::new());
    }
    let borrowed: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let heading = find_section_heading(&borrowed, section).ok_or_else(|| {
        format!("模块卡片已在判定期间变更，找不到 section：{section}（请重试）")
    })?;
    // section 结束位置：下一个 `## ` 标题；没有则文件末尾。
    let end = borrowed[heading + 1..]
        .iter()
        .position(|l| l.starts_with("## "))
        .map(|offset| heading + 1 + offset)
        .unwrap_or(lines.len());
    let mut block: Vec<String> = Vec::new();
    if end == 0 || !lines[end - 1].trim().is_empty() {
        block.push(String::new());
    }
    block.push(format!("- {date} · {}", candidate.content.trim()));
    block.push(format!("  - 依据：{}", candidate.evidence.trim()));
    // 可追溯标记：不打扰阅读，且让「自动写入」的条目可被识别（回滚/审计依赖它）。
    if !trace.is_empty() {
        block.push(format!("  <!-- kg:{trace} -->"));
    }
    if end < lines.len() && lines[end].starts_with("## ") {
        block.push(String::new());
    }
    lines.splice(end..end, block);
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// 把候选整理成质量门输入（含字段截断，避免超长候选撑爆提示词 / argv）。
fn gate_inputs(candidates: &[KnowledgeCandidate], indices: &[usize]) -> Vec<GateInput> {
    indices
        .iter()
        .map(|&index| {
            let candidate = &candidates[index];
            GateInput {
                index,
                module: candidate.module.clone(),
                section: candidate.section.clone(),
                content: truncate_chars(candidate.content.trim(), GATE_FIELD_MAX_CHARS),
                evidence: truncate_chars(candidate.evidence.trim(), GATE_FIELD_MAX_CHARS),
            }
        })
        .collect()
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// 组装 L3 上下文：候选相关度最高的既有条目（跨模块）+ 涉及模块的真实 section 清单。
fn build_gate_context(
    target: &KnowledgeTarget,
    candidates: &[KnowledgeCandidate],
    indices: &[usize],
    entries: &[ExistingEntry],
) -> GateContext {
    let mut related: Vec<ExistingEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut modules: Vec<String> = Vec::new();
    for &index in indices {
        let candidate = &candidates[index];
        if !modules.contains(&candidate.module) {
            modules.push(candidate.module.clone());
        }
        let normalized = knowledge_gate::normalize_knowledge_text(&candidate.content);
        for (entry_index, _) in knowledge_gate::retrieve_similar(
            entries,
            &normalized,
            RELATED_ENTRY_K,
            RELATED_ENTRY_FLOOR,
        ) {
            if related.len() >= RELATED_ENTRY_MAX {
                break;
            }
            let entry = &entries[entry_index];
            if seen.insert(format!("{}|{}", entry.module, entry.normalized)) {
                // 单条内联条目截断：卡片里可能有很长的条目，不设上限会把提示词推向
                // Windows argv 上限（32767），届时**每个**分块都会在命令行层面失败。
                related.push(ExistingEntry {
                    module: entry.module.clone(),
                    text: truncate_chars(&entry.text, RELATED_ENTRY_MAX_CHARS),
                    normalized: entry.normalized.clone(),
                    hash: entry.hash.clone(),
                });
            }
        }
    }
    let mut sections = Vec::new();
    for module in modules {
        if let Ok(path) = module_card_path(target, &module) {
            if let Ok(text) = std::fs::read_to_string(&path) {
                sections.push((module, knowledge_gate::card_section_titles(&text)));
            }
        }
    }
    GateContext { related, sections }
}

/// 按提示词字数上限把候选切成分块，保证每个分块的提示词不超过 argv 上限。
/// 单条候选即便自己就超限也照发（不再无限细分），由字段截断兜底。
fn chunk_gate_inputs(inputs: Vec<GateInput>, context: &GateContext) -> Vec<Vec<GateInput>> {
    let mut chunks: Vec<Vec<GateInput>> = Vec::new();
    let mut current: Vec<GateInput> = Vec::new();
    for input in inputs {
        current.push(input);
        let too_big = knowledge_gate::build_gate_prompt(&current, context)
            .chars()
            .count()
            > MAX_GATE_PROMPT_CHARS;
        if too_big && current.len() > 1 {
            let last = current.pop().expect("current is non-empty");
            chunks.push(std::mem::take(&mut current));
            current.push(last);
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// 跑一次质量门调用。超时 / 非零退出 / 输出不可解析一律返回 `Err`，
/// 由调用方**逐条降级**为未通过（绝不整批报错丢弃知识）。
async fn run_gate_once(
    agent: &str,
    project_path: &str,
    chunk: &[GateInput],
    context: &GateContext,
    reverse: bool,
) -> Result<Vec<GateVerdict>, String> {
    let mut ordered = chunk.to_vec();
    if reverse {
        ordered.reverse();
    }
    let prompt = knowledge_gate::build_gate_prompt(&ordered, context);
    let output = crate::agent_assist::run_headless_agent_with_timeout(
        agent,
        project_path,
        &prompt,
        QUALITY_GATE_TIMEOUT,
        false,
        None,
    )
    .await?;
    if !output.status.success() {
        return Err(format!(
            "质量门执行失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    knowledge_gate::parse_gate_verdicts(&stdout)
        .ok_or_else(|| "质量门未返回 <GATE> 结果".to_string())
}

/// 知识沉淀自动回写：L0 结构 → L1 依据核验 → L2 去重 → L3 语义（双跑）→ 写卡片 → git 提交推送。
///
/// 逐条返回结果；门执行失败（超时等）只把该批候选降级为未通过，不影响其他候选。
#[tauri::command]
pub async fn knowledge_auto_writeback(
    project_path: String,
    suggestions: Vec<KnowledgeCandidate>,
    agent: String,
) -> Result<KnowledgeWritebackResult, String> {
    if !matches!(agent.as_str(), "claude" | "codex") {
        return Err(format!("Unsupported agent: {agent}"));
    }
    if suggestions.is_empty() {
        return Err("知识候选为空".to_string());
    }
    let target = resolve_knowledge_target(project_path.clone()).await?;
    let _write_guard = lock_graph(&target.id).await;
    // 与 hub 后台同步互斥：图谱数据就在 hub 检出里，同步的 fetch/pull 与本次
    // add/commit/push 操作同一仓库，必须真互斥而非观测（见 skills::lock_hub_git）。
    let _hub_git_guard = crate::skills::lock_hub_git().await;
    let project_root = PathBuf::from(&project_path);

    // L0 结构层：逐条结构校验，不通过直接出局（不进后续层）。
    let mut items: Vec<KnowledgeWritebackItem> = Vec::new();
    let mut structural_passed: Vec<usize> = Vec::new();
    for (index, candidate) in suggestions.iter().enumerate() {
        let item = match validate_candidate(&target, candidate) {
            Ok(()) => {
                structural_passed.push(index);
                KnowledgeWritebackItem {
                    index,
                    module: candidate.module.clone(),
                    section: candidate.section.clone(),
                    passed: true,
                    written: false,
                    reason: String::new(),
                    layer: "L0".to_string(),
                }
            }
            Err(reason) => KnowledgeWritebackItem {
                index,
                module: candidate.module.clone(),
                section: candidate.section.clone(),
                passed: false,
                written: false,
                reason,
                layer: "L0".to_string(),
            },
        };
        items.push(item);
    }

    // L1 依据核验 + L2 去重（确定性，整图语料一次载入）。
    let mut semantic_passed: Vec<usize> = Vec::new();
    if !structural_passed.is_empty() {
        let entries = {
            let graph = target.clone();
            tokio::task::spawn_blocking(move || load_graph_entries(&graph))
                .await
                .map_err(|e| format!("读取图谱条目线程错误: {e}"))??
        };
        let outcomes = {
            let root = project_root.clone();
            let candidates = suggestions.clone();
            let indices = structural_passed.clone();
            let entries = entries.clone();
            tokio::task::spawn_blocking(move || {
                run_deterministic_layers(&root, &candidates, &indices, &entries)
            })
            .await
            .map_err(|e| format!("依据核验线程错误: {e}"))?
        };
        for (index, verdict) in outcomes {
            let Some(item) = items.iter_mut().find(|item| item.index == index) else {
                continue;
            };
            match verdict.rejection {
                Some((layer, reason)) => {
                    item.passed = false;
                    item.layer = layer;
                    item.reason = reason;
                }
                None => {
                    item.layer = "L1".to_string();
                    item.reason = verdict.note;
                    semantic_passed.push(index);
                }
            }
        }

        // L3 语义层：内联上下文，分批 + 双跑一致才放行。
        if !semantic_passed.is_empty() {
            let context = {
                let graph = target.clone();
                let candidates = suggestions.clone();
                let indices = semantic_passed.clone();
                let entries = entries.clone();
                tokio::task::spawn_blocking(move || {
                    build_gate_context(&graph, &candidates, &indices, &entries)
                })
                .await
                .map_err(|e| format!("组装质量门上下文线程错误: {e}"))?
            };
            let chunks = chunk_gate_inputs(gate_inputs(&suggestions, &semantic_passed), &context);
            for chunk in chunks {
                let indices: Vec<usize> = chunk.iter().map(|input| input.index).collect();
                let first = run_gate_once(&agent, &project_path, &chunk, &context, false).await;
                let second = run_gate_once(&agent, &project_path, &chunk, &context, true).await;
                let (first, second) = match (first, second) {
                    (Ok(first), Ok(second)) => (Some(first), Some(second)),
                    (Err(error), _) | (_, Err(error)) => {
                        for index in &indices {
                            if let Some(item) = items.iter_mut().find(|item| item.index == *index) {
                                item.passed = false;
                                item.layer = "L3".to_string();
                                item.reason =
                                    format!("质量门未完成，逐条降级为未通过：{error}");
                            }
                        }
                        continue;
                    }
                };
                for index in &indices {
                    let first_verdict = first
                        .as_ref()
                        .and_then(|verdicts| verdicts.iter().find(|v| v.index == *index));
                    let second_verdict = second
                        .as_ref()
                        .and_then(|verdicts| verdicts.iter().find(|v| v.index == *index));
                    let Some(item) = items.iter_mut().find(|item| item.index == *index) else {
                        continue;
                    };
                    item.layer = "L3".to_string();
                    match knowledge_gate::decide_dual(first_verdict, second_verdict) {
                        Ok(()) => item.passed = true,
                        Err(reason) => {
                            item.passed = false;
                            item.reason = reason;
                        }
                    }
                }
            }
        }
    }

    // 写入通过的条目（同模块多次写入按顺序累积）。
    // 一次性取全部待写入模块的 git 状态，避免每写一条就跑一次 git status。
    let writable: Vec<usize> = items
        .iter()
        .filter(|item| item.passed)
        .map(|item| item.index)
        .collect();
    let dirty_modules = if writable.is_empty() {
        HashSet::new()
    } else {
        let modules: Vec<String> = writable
            .iter()
            .map(|index| suggestions[*index].module.clone())
            .collect();
        dirty_module_cards(&target, &modules).await?
    };
    // 本次沉淀的溯源标记：同一个 token 写进所有条目，便于按批追溯与回滚。
    let trace_token = sediment_trace_token(&target.id);
    let mut changed_docs: Vec<PathBuf> = Vec::new();
    for index in writable {
        let candidate = &suggestions[index];
        if dirty_modules.contains(&candidate.module) {
            if let Some(item) = items.iter_mut().find(|item| item.index == index) {
                item.passed = false;
                item.written = false;
                item.layer = "write".to_string();
                item.reason = "目标模块卡片存在未提交人工修改".to_string();
            }
            continue;
        }
        // 换行会让内容伪造出 `## ` 标题，把后续条目挂到假 section 下（写入完整性）。
        if candidate.content.contains('\n') || candidate.evidence.contains('\n') {
            if let Some(item) = items.iter_mut().find(|item| item.index == index) {
                item.passed = false;
                item.layer = "L0".to_string();
                item.reason = "内容或依据包含换行，会破坏卡片结构".to_string();
            }
            continue;
        }
        let doc = module_doc_path(&target, &candidate.module);
        let current = std::fs::read_to_string(&doc)
            .map_err(|e| format!("写入前读取 {} 失败: {e}", candidate.module))?;
        let next = append_entry(&current, &candidate.section, candidate, &trace_token)
            .map_err(|e| format!("{}: {e}", candidate.module))?;
        std::fs::write(&doc, next).map_err(|e| format!("写入 {} 失败: {e}", candidate.module))?;
        if !changed_docs.contains(&doc) {
            changed_docs.push(doc);
        }
        if let Some(item) = items.iter_mut().find(|item| item.index == index) {
            item.written = true;
            item.layer = "write".to_string();
            // 保留 L1 的依据核验结论，便于事后追溯这条为何被认为有据。
            item.reason = if item.reason.is_empty() {
                "已自动写入模块卡片".to_string()
            } else {
                format!("已自动写入模块卡片（{}）", item.reason)
            };
        }
    }

    // 4) git：先补推未推送的本地提交，再提交本次写入，最后推送。
    //    「补推」是必须的：push 失败后重跑时，卡片里已有那些条目 ⇒ 会被去重层判为重复
    //    ⇒ 本次没有新写入 ⇒ 若只依赖「有写入才提交」，那些本地提交会**永远推不上去**。
    let pushed_before = push_pending_commits(&target).await?;

    let written_count = items.iter().filter(|i| i.written).count();
    let mut commit: Option<String> = None;
    if written_count > 0 {
        let mut add_args: Vec<String> = vec!["add".into(), "--".into()];
        for doc in &changed_docs {
            let rel = doc
                .strip_prefix(&target.graph_dir)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            add_args.push(rel);
        }
        let add = crate::git::run_git_with_timeout(
            target.graph_dir.clone(),
            add_args,
            std::time::Duration::from_secs(30),
        )
        .await?;
        if !add.status.success() {
            return Err(format!(
                "git add 失败: {}",
                String::from_utf8_lossy(&add.stderr).trim()
            ));
        }
        let message = format!(
            "docs(knowledge): auto sediment {written_count} entries via Nezha

kg={trace_token}"
        );
        let commit_out = crate::git::run_git_with_timeout(
            target.graph_dir.clone(),
            vec!["commit".into(), "-m".into(), message.clone()],
            std::time::Duration::from_secs(30),
        )
        .await?;
        if !commit_out.status.success() {
            return Err(format!(
                "git commit 失败: {}",
                String::from_utf8_lossy(&commit_out.stderr).trim()
            ));
        }
        let push = crate::git::run_git_with_timeout(
            target.graph_dir.clone(),
            vec!["push".into()],
            std::time::Duration::from_secs(120),
        )
        .await?;
        if !push.status.success() {
            return Err(format!(
                "已提交但推送失败: {}（本地提交已保留，可手动 push 后关闭议题）",
                String::from_utf8_lossy(&push.stderr).trim()
            ));
        }
        commit = Some(message);
    }

    let all_passed = items.iter().all(|i| i.passed);
    Ok(KnowledgeWritebackResult {
        items,
        all_passed,
        written_count,
        commit,
        pushed_pending: pushed_before,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_target() -> KnowledgeTarget {
        KnowledgeTarget {
            id: "ICUCIS".into(),
            name: "ICUCIS 重症系统知识图谱".into(),
            adapter: "icucis".into(),
            graph_dir: "C:/skills/knowledge-graphs/ICUCIS".into(),
            skill_dir: "C:/skills/knowledge-graph".into(),
            data_dir: "C:/skills/knowledge-graphs/ICUCIS/data".into(),
            ready: true,
            scan_available: true,
        }
    }

    #[test]
    fn module_doc_uses_selected_target() {
        let path = module_doc_path(&sample_target(), "io");
        assert!(path
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("ICUCIS/data/modules/io.md"));
    }

    #[test]
    fn rejects_candidate_bound_to_other_graph() {
        let target = sample_target();
        let candidate = KnowledgeCandidate {
            module: "io".into(),
            section: "职责".into(),
            content: "内容".into(),
            evidence: "Service.cs:1".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "HIS".into(),
        };
        let error = validate_candidate(&target, &candidate).unwrap_err();
        assert!(error.contains("绑定知识库不一致"));
    }
    #[test]
    fn normalizes_section_aliases() {
        assert_eq!(
            normalize_section("关键实体 / 数据表"),
            normalize_section("关键实体与数据表")
        );
        assert_eq!(
            normalize_section(" 业务规则 / 已知坑 "),
            normalize_section("业务规则与已知坑")
        );
        assert_eq!(
            normalize_section("UI 界面 / 入口"),
            normalize_section("UI界面与入口")
        );
    }

    #[test]
    fn matches_ui_entry_section_heading() {
        let doc = "# M\n\n## UI 界面 / 入口\n\n（待补充）\n";
        let lines: Vec<&str> = doc.lines().collect();
        assert!(find_section_heading(&lines, "UI界面与入口").is_some());
        assert!(find_section_heading(&lines, "UI 界面 / 入口").is_some());
    }

    fn temp_project_with_graph(tag: &str, graph_id: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nezha-kg-env-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".nezha")).unwrap();
        // 注意：ProjectConfig 的 `agent` / `git` 段是**必填**，而 `read_project_config`
        // 在 toml 解析失败时会静默回退到 Default（知识图谱绑定一起丢失）。因此夹具
        // 必须写成完整段，否则测到的是「解析失败」而不是「未绑定图谱」。
        let knowledge = match graph_id {
            Some(id) => format!("[knowledge]
graph_id = \"{id}\"
"),
            None => String::new(),
        };
        let config = format!(
            "[agent]
default = \"claude\"

[git]
commit_prompt = \"x\"

{knowledge}"
        );
        std::fs::write(dir.join(".nezha").join("config.toml"), config).unwrap();
        dir
    }

    #[test]
    fn knowledge_env_is_empty_for_unbound_project() {
        // 未绑定图谱：不注入任何环境变量，agent 行为与原来一致。
        let dir = temp_project_with_graph("unbound", None);
        let env = knowledge_env_for_project(dir.to_str().unwrap());
        assert!(env.is_empty(), "未绑定项目不应注入：{env:?}");
        // 目录不存在 / 无配置时同样为空，且不 panic。
        assert!(knowledge_env_for_project("H:/definitely/not/here").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn knowledge_env_exposes_graph_id_and_data_dir_when_hub_configured() {
        let dir = temp_project_with_graph("bound", Some("HIS"));
        let env = knowledge_env_for_project(dir.to_str().unwrap());
        if crate::skills::configured_hub_path().is_none() {
            // 未配置技能库时无法定位数据目录：按 best-effort 返回空（不注入）。
            assert!(env.is_empty(), "未配置 hub 时不应注入：{env:?}");
        } else {
            let map: std::collections::HashMap<_, _> = env.iter().cloned().collect();
            assert_eq!(
                map.get("NEZHA_KNOWLEDGE_GRAPH_ID").map(String::as_str),
                Some("HIS")
            );
            let data_dir = map.get("NEZHA_KNOWLEDGE_GRAPH_DIR").expect("数据目录");
            assert!(
                data_dir.replace('\\', "/").ends_with("knowledge-graphs/HIS/data"),
                "数据目录应以 knowledge-graphs/<id>/data 结尾：{data_dir}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实仓库上的集成检查：`NEZHA_KG_E2E_PROJECT` 指向绑定图谱的项目。
    #[test]
    #[ignore = "需要本机真实项目（如 HIS 检出）"]
    fn acceptance_knowledge_env_on_real_project() {
        let Ok(project) = std::env::var("NEZHA_KG_E2E_PROJECT") else {
            eprintln!("SKIP: 未设置 NEZHA_KG_E2E_PROJECT");
            return;
        };
        let env = knowledge_env_for_project(&project);
        let map: std::collections::HashMap<_, _> = env.iter().cloned().collect();
        let graph_id = map.get("NEZHA_KNOWLEDGE_GRAPH_ID").expect("应注入 graph id");
        let data_dir = map.get("NEZHA_KNOWLEDGE_GRAPH_DIR").expect("应注入数据目录");
        println!("{project} -> graph={graph_id} dir={data_dir}");
        // 注入的数据目录必须真实存在，否则 agent 拿到的是死路径。
        assert!(
            std::path::Path::new(data_dir).is_dir(),
            "注入的数据目录应真实存在：{data_dir}"
        );
    }

    #[test]
    fn append_without_trace_omits_marker() {
        // 无 token 时不留空标记（避免产生无信息的残留注释）。
        let candidate = KnowledgeCandidate {
            module: "M".into(),
            section: "职责".into(),
            content: "某职责".into(),
            evidence: "X.cs".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "ICUCIS".into(),
        };
        let next = append_entry(&sample_doc(), "职责", &candidate, "").expect("追加成功");
        assert!(next.contains("某职责"));
        assert!(!next.contains("<!-- kg:"), "无 token 不应写标记：{next}");
    }

    #[test]
    fn trace_token_is_graph_scoped_and_unique() {
        let a = sediment_trace_token("HIS");
        assert!(a.starts_with("HIS@"), "{a}");
        // 结构：`<图谱>@<UTC 时间戳 Z>.<8 位随机段>`
        let (stamp, suffix) = a.split_once('Z').expect("应含时间戳终止符 Z");
        assert!(stamp.contains('T'), "时间戳应含 T：{a}");
        assert_eq!(suffix.strip_prefix('.').map(str::len), Some(8), "随机段长度：{a}");
        // 连续两次必须不同：同毫秒内调用不会撞 token（实测毫秒时间戳会撞）。
        let b = sediment_trace_token("HIS");
        assert_ne!(a, b, "同图谱两次调用应生成不同 token");
    }

    /// 真实 git 仓库上的集成检查：`push_pending_commits` 的行为不变量。
    ///
    /// 需要 `NEZHA_KG_E2E_REPO` 指向一个图谱写操作仓库。按仓库实际状态断言两种之一：
    /// - **仅领先**（本地有未推送提交）：必须补推成功，且推完后 `@{u}..HEAD` 为 0；
    /// - **已分叉**（同时领先与落后）：必须**拒绝**，且**不得**留下 merge / rebase 半成品状态。
    ///
    /// 夹具建立方式：`git init --bare origin.git` → clone → 提交并 push → 再本地提交一次
    /// 即得「仅领先」；在此基础上让另一个 clone 抢先 push 一次即得「已分叉」。
    #[tokio::test]
    #[ignore = "需要本机临时 git 仓库（NEZHA_KG_E2E_REPO）"]
    async fn acceptance_push_pending_commits() {
        let Ok(repo) = std::env::var("NEZHA_KG_E2E_REPO") else {
            eprintln!("SKIP: 未设置 NEZHA_KG_E2E_REPO");
            return;
        };
        let target = KnowledgeTarget {
            id: "T".into(),
            name: "T".into(),
            adapter: "dotnet".into(),
            graph_dir: repo.clone(),
            skill_dir: repo.clone(),
            data_dir: repo.clone(),
            ready: true,
            scan_available: false,
        };
        let count = |spec: &str| {
            let repo = repo.clone();
            let spec = spec.to_string();
            async move {
                let out = crate::git::run_git_with_timeout(
                    repo,
                    vec!["rev-list".into(), "--count".into(), spec],
                    std::time::Duration::from_secs(15),
                )
                .await
                .expect("读取提交计数");
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
        };

        // 先 fetch 一次，让后面的 ahead/behind 判定基于最新远端状态。
        let _ = crate::git::run_git_with_timeout(
            repo.clone(),
            vec!["fetch".into(), "origin".into()],
            std::time::Duration::from_secs(120),
        )
        .await;
        let ahead0 = count("@{u}..HEAD").await;
        let behind0 = count("HEAD..@{u}").await;
        println!("初始 ahead={ahead0} behind={behind0}");

        let result = push_pending_commits(&target).await;

        if behind0 == "0" {
            // 仅领先：应补推成功。
            assert!(result.is_ok(), "仅领先时应补推成功：{result:?}");
            assert_eq!(count("@{u}..HEAD").await, "0", "补推后应无未推送提交");
        } else {
            // 已分叉：必须拒绝，且不留下 merge/rebase 状态。
            assert!(result.is_err(), "分叉时应拒绝写入：{result:?}");
            let msg = result.unwrap_err();
            assert!(msg.contains("无法快进") || msg.contains("分叉"), "{msg}");
            for marker in [".git/MERGE_HEAD", ".git/rebase-merge", ".git/rebase-apply"] {
                assert!(
                    !std::path::Path::new(&repo).join(marker).exists(),
                    "拒绝后不应留下半成品状态：{marker}"
                );
            }
            assert_eq!(count("@{u}..HEAD").await, ahead0, "本地提交应保留");
        }
    }

    /// 自动沉淀的候选抽取：从契约产物到写入候选的转换必须保持字段与图谱绑定。
    /// （真正的写入由 `knowledge_auto_writeback` 负责，此处只验转换与前置判定。）
    #[test]
    fn auto_sediment_skips_when_contract_says_skipped() {
        let raw = r#"{"version":1,"skipped":true,"skipReason":"仅样式调整"}"#;
        let parsed = crate::agent_assist::parse_knowledge_draft(raw, "HIS").expect("解析");
        assert!(parsed.is_skipped());
        assert!(parsed.candidates().is_empty());
    }

    #[test]
    fn auto_sediment_requires_non_empty_candidates_to_write() {
        // 空候选列表（未显式 skipped）不应触发写入，也不应报错。
        let raw = r#"{"version":1,"skipped":false,"candidates":[]}"#;
        let parsed = crate::agent_assist::parse_knowledge_draft(raw, "HIS").expect("解析");
        assert!(!parsed.is_skipped());
        assert!(parsed.candidates().is_empty());
    }

    #[test]
    fn auto_sediment_carries_graph_binding_from_contract() {
        // 契约未写 graphId 时由兜底填充，转换后仍应绑定当前图谱。
        let raw = r#"[{"module":"M","section":"职责","content":"c","evidence":"e","confidence":"confirmed"}]"#;
        let parsed = crate::agent_assist::parse_knowledge_draft(raw, "ICUCIS").expect("解析");
        let mapped: Vec<super::KnowledgeCandidate> = parsed
            .candidates()
            .iter()
            .map(|s| super::KnowledgeCandidate {
                module: s.module.clone(),
                section: s.section.clone(),
                content: s.content.clone(),
                evidence: s.evidence.clone(),
                confidence: s.confidence.clone(),
                suggested_title: s.suggested_title.clone(),
                knowledge_graph_id: s.knowledge_graph_id.clone(),
            })
            .collect();
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].knowledge_graph_id, "ICUCIS");
    }

    #[test]
    fn empty_writeback_result_is_all_passed_and_unwritten() {
        let result = empty_writeback_result();
        assert!(result.all_passed);
        assert_eq!(result.written_count, 0);
        assert!(result.commit.is_none());
        assert!(!result.pushed_pending);
    }

    #[test]
    fn rejects_scan_generated_section() {
        let target = sample_target();
        let mut candidate = KnowledgeCandidate {
            module: "io".into(),
            section: "定位".into(),
            content: "内容".into(),
            evidence: "Service.cs:1".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "ICUCIS".into(),
        };
        // 与卡片是否存在无关：该判定发生在读卡片之前。
        let error = validate_candidate(&target, &candidate).unwrap_err();
        assert!(error.contains("由扫描生成"), "{error}");
        // 归一化后同样是「定位」的写法也要拦住。
        candidate.section = " 定位 ".into();
        assert!(validate_candidate(&target, &candidate).is_err());
        // 可写段不受影响（此处仍会在「卡片不存在」处被拒，但不是被本规则拒）。
        candidate.section = "职责".into();
        let other = validate_candidate(&target, &candidate).unwrap_err();
        assert!(!other.contains("由扫描生成"), "{other}");
    }

    /// `GRAPH_WRITE_ACTIVE` 是全局计数：本例是**唯一**使用它的用例，
    /// 把「计数随持锁增减」与「排队等待者不计入」合并在一处，
    /// 避免两个并行用例互相观测到对方持有的锁而抖动。
    #[tokio::test]
    async fn graph_write_guard_tracks_in_progress() {
        assert!(!knowledge_write_in_progress(), "初始应为空闲");

        let first = lock_graph("test-graph-a").await;
        assert!(knowledge_write_in_progress(), "持锁期间应报告写入中");
        // 不同图谱可以并发持有，计数累加。
        let second = lock_graph("test-graph-b").await;
        assert!(knowledge_write_in_progress());
        drop(second);
        assert!(knowledge_write_in_progress(), "仍有持有者时不应复位");

        // 同图谱的排队者：计数必须在**拿到锁之后**才 +1，否则 hub 同步会因为
        // 排队者而空转等待。这里断言**精确值**——若把 fetch_add 提到 lock 之前，
        // 排队者会让计数变成 2，本断言即失败（只看「最终归零」是钉不住这个性质的）。
        let waiter = tokio::spawn(async move {
            let _guard = lock_graph("test-graph-a").await;
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        assert_eq!(
            graph_write_active_count(),
            1,
            "持有者 1 个；排队的 waiter 不应计入"
        );
        drop(first);
        let _ = waiter.await;
        assert_eq!(graph_write_active_count(), 0, "全部释放后应归零");
    }

    #[test]
    fn rejects_unsafe_module_names() {
        assert!(module_is_safe("Hsp.BaseData.Cache"));
        assert!(!module_is_safe("../etc/passwd"));
        assert!(!module_is_safe("a/b"));
        assert!(!module_is_safe(""));
    }

    fn sample_doc() -> String {
        "# Hsp.BaseData.Cache（缓存）\n\n## 职责\n\n缓存。\n\n## 业务规则 / 已知坑\n\n（待补充）\n\n## 验证记录\n\n（待补充）\n".to_string()
    }

    #[test]
    fn appends_entry_into_matching_section() {
        let candidate = KnowledgeCandidate {
            module: "Hsp.BaseData.Cache".into(),
            section: "业务规则与已知坑".into(),
            content: "缓存键必须带租户前缀".into(),
            evidence: "Hsp.BaseData.Cache.Bll/CacheService.cs:42".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "HIS".into(),
        };
        let next = append_entry(&sample_doc(), &candidate.section, &candidate, "ICUCIS@20260917T000000.000Z")
            .expect("追加成功");
        let in_section = next
            .split("## 业务规则 / 已知坑")
            .nth(1)
            .and_then(|rest| rest.split("## 验证记录").next())
            .unwrap_or_default();
        assert!(in_section.contains("缓存键必须带租户前缀"));
        assert!(in_section.contains("依据：Hsp.BaseData.Cache.Bll/CacheService.cs:42"));
        // 可追溯标记：自动写入的条目可被识别，回滚/审计依赖它。
        assert!(
            in_section.contains("<!-- kg:ICUCIS@20260917T000000.000Z -->"),
            "应带溯源标记：{in_section}"
        );
        // 条目格式：`- <日期> · <内容>`，不再写入恒定的「已确认」（只有 confirmed 能过门）。
        assert!(!in_section.contains("已确认"), "{in_section}");
        assert!(in_section.contains("· 缓存键必须带租户前缀") || in_section.contains("缓存键必须带租户前缀"));
        // 只增不改：原有内容仍在。
        assert!(next.contains("（待补充）"));
    }

    #[test]
    fn append_entry_degrades_when_section_changed_underneath() {
        // 校验与写入之间卡片被改动（hub 拉取 / 人工编辑）⇒ 必须优雅失败，不能 panic。
        let candidate = KnowledgeCandidate {
            module: "M".into(),
            section: "业务规则与已知坑".into(),
            content: "某条规则".into(),
            evidence: "X.cs".into(),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "HIS".into(),
        };
        let err = append_entry(&sample_doc(), "不存在的 section", &candidate, "").unwrap_err();
        assert!(err.contains("已在判定期间变更"), "{err}");
    }

    #[test]
    fn parses_gate_verdict_block() {
        let stdout = "前言\n<GATE>[{\"index\":0,\"verdict\":\"distinct\",\"reason\":\"ok\"},{\"index\":1,\"verdict\":\"conflict\",\"reason\":\"与现状冲突\"}]</GATE>\n后记";
        let verdicts = knowledge_gate::parse_gate_verdicts(stdout).expect("parses");
        assert_eq!(verdicts.len(), 2);
        assert_eq!(verdicts[0].decision().unwrap(), true);
        assert_eq!(verdicts[1].reason, "与现状冲突");
    }

    #[test]
    fn l0_rejects_unconfirmed_confidence_without_touching_disk() {
        let target = sample_target();
        let candidate = KnowledgeCandidate {
            module: "io".into(),
            section: "职责".into(),
            content: "内容".into(),
            evidence: "Service.cs:1".into(),
            confidence: "pending".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "ICUCIS".into(),
        };
        // confidence 校验在目标卡片存在性之前，因此不依赖磁盘状态。
        let error = validate_candidate(&target, &candidate).unwrap_err();
        assert!(error.contains("仅 confirmed 可自动回写"), "{error}");
    }

    #[test]
    fn truncate_chars_respects_char_boundaries() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        assert_eq!(truncate_chars("abcd", 3), "abc…");
        // 中文按字符而非字节截断，不应产生乱码。
        assert_eq!(truncate_chars("知识沉淀规则", 3), "知识沉…");
    }

    #[test]
    fn chunks_split_before_exceeding_prompt_budget() {
        let context = GateContext::default();
        let make = |index: usize, size: usize| GateInput {
            index,
            module: "M".into(),
            section: "职责".into(),
            content: "x".repeat(size),
            evidence: "X.cs".into(),
        };
        // 三个大候选应被拆成多个分块，且每个分块的提示词不超上限。
        let chunks = chunk_gate_inputs(
            vec![make(0, 12_000), make(1, 12_000), make(2, 12_000)],
            &context,
        );
        assert!(chunks.len() >= 2, "应当分批：{chunks:?}");
        let total: usize = chunks.iter().map(Vec::len).sum();
        assert_eq!(total, 3, "不能丢失候选");
        for chunk in &chunks {
            assert!(
                knowledge_gate::build_gate_prompt(chunk, &context)
                    .chars()
                    .count()
                    <= MAX_GATE_PROMPT_CHARS
            );
        }
        // 顺序必须保持稳定（index 递增），避免与双跑换序混淆。
        let flat: Vec<usize> = chunks.iter().flatten().map(|input| input.index).collect();
        assert_eq!(flat, vec![0, 1, 2]);
    }

    #[test]
    fn chunks_keep_single_oversized_candidate() {
        let context = GateContext::default();
        let input = GateInput {
            index: 0,
            module: "M".into(),
            section: "职责".into(),
            content: "x".repeat(MAX_GATE_PROMPT_CHARS * 2),
            evidence: "X.cs".into(),
        };
        let chunks = chunk_gate_inputs(vec![input], &context);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 1, "单条超限不能丢，交给字段截断兜底");
    }

    #[test]
    fn gate_inputs_truncate_oversized_fields() {
        let candidate = KnowledgeCandidate {
            module: "M".into(),
            section: "职责".into(),
            content: "内".repeat(GATE_FIELD_MAX_CHARS + 100),
            evidence: "E".repeat(GATE_FIELD_MAX_CHARS + 100),
            confidence: "confirmed".into(),
            suggested_title: String::new(),
            knowledge_graph_id: "ICUCIS".into(),
        };
        let inputs = gate_inputs(std::slice::from_ref(&candidate), &[0]);
        assert_eq!(inputs[0].content.chars().count(), GATE_FIELD_MAX_CHARS + 1);
        assert_eq!(inputs[0].evidence.chars().count(), GATE_FIELD_MAX_CHARS + 1);
    }
}

// ── L3 验收回归（opt-in）───────────────────────────────────────────
// 用真实 CLI 跑 L3 双跑，验证重复 / 冲突被拒。默认 `#[ignore]`：会发起真实模型调用。
// 跑法：`cargo test --lib acceptance_l3 -- --ignored --nocapture`（需 codex/claude 可用）。
#[cfg(test)]
mod acceptance_l3 {
    use super::*;

    fn real_target(card: &str) -> KnowledgeTarget {
        let data_dir = std::path::Path::new(card).parent().unwrap().parent().unwrap();
        let graph_dir = data_dir.parent().unwrap();
        KnowledgeTarget {
            id: "HIS".into(),
            name: "HIS 知识图谱".into(),
            adapter: "dotnet".into(),
            graph_dir: graph_dir.to_string_lossy().into_owned(),
            skill_dir: graph_dir.parent().unwrap().join("knowledge-graph").to_string_lossy().into_owned(),
            data_dir: data_dir.to_string_lossy().into_owned(),
            ready: true,
            scan_available: true,
        }
    }

    #[tokio::test]
    #[ignore = "会发起真实 CLI 调用（codex/claude）"]
    async fn acceptance_l3_dual_run() {
        let Ok(root) = std::env::var("NEZHA_KG_E2E_ROOT") else { eprintln!("SKIP"); return; };
        let card_path = std::env::var("NEZHA_KG_E2E_CARD").expect("card");
        let project = std::env::var("NEZHA_KG_E2E_PROJECT").expect("project");
        let agent = std::env::var("NEZHA_KG_E2E_AGENT").unwrap_or_else(|_| "codex".into());
        let card = std::fs::read_to_string(&card_path).expect("read card");
        let target = real_target(&card_path);
        let _ = card;

        let raw = std::fs::read_to_string(std::path::Path::new(&root).join("candidates.json")).unwrap();
        let values: Vec<serde_json::Value> = serde_json::from_str(&raw).unwrap();
        let suggestions: Vec<KnowledgeCandidate> = values.iter().map(|v| KnowledgeCandidate {
            module: v["module"].as_str().unwrap_or("").into(),
            section: v["section"].as_str().unwrap_or("").into(),
            content: v["content"].as_str().unwrap_or("").into(),
            evidence: v["evidence"].as_str().unwrap_or("").into(),
            confidence: v["confidence"].as_str().unwrap_or("").into(),
            suggested_title: String::new(),
            knowledge_graph_id: "HIS".into(),
        }).collect();

        let indices: Vec<usize> = (0..suggestions.len()).collect();
        let entries = load_graph_entries(&target).expect("entries");
        let context = build_gate_context(&target, &suggestions, &indices, &entries);
        println!("== 内联既有条目 {} 条；涉及模块 {} 个", context.related.len(), context.sections.len());

        let chunks = chunk_gate_inputs(gate_inputs(&suggestions, &indices), &context);
        println!("== 分块数 {}", chunks.len());
        for chunk in chunks {
            let first = run_gate_once(&agent, &project, &chunk, &context, false).await;
            let second = run_gate_once(&agent, &project, &chunk, &context, true).await;
            let (first, second) = match (first, second) {
                (Ok(a), Ok(b)) => (a, b),
                (a, b) => { println!("门失败: {:?} / {:?}", a.err(), b.err()); continue; }
            };
            for input in &chunk {
                let idx = input.index;
                let f = first.iter().find(|v| v.index == idx);
                let s = second.iter().find(|v| v.index == idx);
                let kind = values.get(idx).and_then(|v| v["kind"].as_str()).unwrap_or("?");
                match knowledge_gate::decide_dual(f, s) {
                    Ok(()) => println!("[{idx}] {kind:26} -> PASS (双跑一致 distinct)"),
                    Err(reason) => println!("[{idx}] {kind:26} -> REJECT: {reason}"),
                }
            }
        }
    }
}

