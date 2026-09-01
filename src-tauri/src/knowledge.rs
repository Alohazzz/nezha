//! 知识沉淀自动回写：把通过「规则 + Agent」两层质量门的知识候选写入
//! 项目配置绑定的知识图谱模块卡片，并 git 提交推送，
//! 替代「知识库负责人手工更新模块卡片」这最后一公里。
//!
//! 设计要点（与产品决策一致）：
//! - 规则层（不调 LLM）：evidence 非空、confidence=confirmed、模块/section 合法、
//!   目标文件存在、内容未重复。挡掉明显不合格的候选，零成本、确定性。
//! - Agent 层：一次 headless 调用批量语义质检（去重 / 冲突 / 依据相关性），
//!   技能规则由 SkillHub 的 `knowledge-quality-gate` 统一维护。
//! - 只增不改：在对应 section 末尾追加「日期 + 置信度 + 内容 + 依据」，保留既有内容。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
    #[serde(default)]
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
}

/// 一次提交的整体回写结果。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeWritebackResult {
    pub items: Vec<KnowledgeWritebackItem>,
    pub all_passed: bool,
    pub written_count: usize,
    pub commit: Option<String>,
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

async fn lock_graph(graph_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    let locks = GRAPH_WRITE_LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let lock = locks
        .lock()
        .expect("graph write locks poisoned")
        .entry(graph_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    lock.lock_owned().await
}

async fn module_card_has_uncommitted_changes(
    graph: &KnowledgeTarget,
    module: &str,
) -> Result<bool, String> {
    let path = module_card_path(graph, module)?;
    let rel = path
        .strip_prefix(&graph.graph_dir)
        .map_err(|_| "模块卡片路径越界".to_string())?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    let result = crate::git::run_git_with_timeout(
        graph.graph_dir.clone(),
        vec!["status".into(), "--porcelain".into(), "--".into(), rel],
        std::time::Duration::from_secs(10),
    )
    .await?;
    Ok(!String::from_utf8_lossy(&result.stdout).trim().is_empty())
}

const QUALITY_GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

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
        std::fs::create_dir_all(data.join("modules")).map_err(io)?;
        std::fs::write(graph_dir.join("graph.toml"), format!("id = \"{graph_id}\"\nname = \"{}\"\nadapter = \"{adapter}\"\n", name.trim())).map_err(io)?;
        std::fs::write(data.join("_template.md"), "# <module>\n\n## 定位\n\n## 职责\n\n## 关键实体 / 数据表\n\n## 依赖与相关模块\n\n## 业务规则 / 已知坑\n\n## 验证记录\n").map_err(io)?;
        std::fs::write(data.join("index.md"), "# Knowledge Graph\n\n## Modules\n\n| Module | Card |\n|---|---|\n").map_err(io)?;
        std::fs::write(data.join("graph.json"), "{\n  \"modules\": [],\n  \"dependencies\": []\n}\n").map_err(io)?;
        let mut config = crate::config::read_project_config(project_path.clone())?;
        config.knowledge.graph_id = graph_id.clone();
        crate::config::write_project_config(project_path, config)?;
        Ok(KnowledgeTarget { id: graph_id, name: name.trim().into(), adapter, graph_dir: graph_dir.to_string_lossy().into_owned(), skill_dir: generic.to_string_lossy().into_owned(), data_dir: data.to_string_lossy().into_owned(), ready: true, scan_available: true })
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
            std::fs::write(&template, "# <module>\n\n## 定位\n\n## 职责\n\n## 关键实体 / 数据表\n\n## 依赖与相关模块\n\n## 业务规则 / 已知坑\n\n## 验证记录\n").map_err(io)?;
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
    let graph = graph_by_id_async(graph_id.clone()).await?;
    let _guard = lock_graph(&graph.id).await;
    if message.trim().is_empty() || paths.is_empty() {
        return Err("提交内容和路径不能为空".into());
    }
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
fn module_doc_path(target: &KnowledgeTarget, module: &str) -> PathBuf {
    Path::new(&target.graph_dir)
        .join("data")
        .join("modules")
        .join(format!("{module}.md"))
}

/// 在模块文档中定位 section 标题行号（`## <标题>`），按归一化标题匹配。
fn find_section_heading(lines: &[&str], section: &str) -> Option<usize> {
    let target = normalize_section(section);
    lines.iter().enumerate().find_map(|(idx, line)| {
        let rest = line.strip_prefix("## ")?;
        (normalize_section(rest.trim()) == target).then_some(idx)
    })
}

/// 校验单个候选的结构合法性（规则层）。返回 Ok(文件内容) 或 拒绝原因。
fn validate_candidate(
    target: &KnowledgeTarget,
    candidate: &KnowledgeCandidate,
) -> Result<String, String> {
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
    // 规则层兜底去重：内容已逐字存在时直接拒绝（语义去重交给 Agent 层）。
    if content.contains(candidate.content.trim()) {
        return Err("内容已存在于模块卡片（重复沉淀）".to_string());
    }
    Ok(content)
}

/// Agent 质量门的单项判定。
#[derive(Deserialize, Clone, Debug)]
struct GateVerdict {
    index: usize,
    passed: bool,
    #[serde(default)]
    reason: String,
}

/// 从 headless 输出中解析 <GATE> JSON 数组；缺失时返回 None（调用方按全不过处理）。
fn parse_gate_verdicts(stdout: &str) -> Option<Vec<GateVerdict>> {
    const OPEN: &str = "<GATE>";
    const CLOSE: &str = "</GATE>";
    let close_pos = stdout.rfind(CLOSE)?;
    let prefix = &stdout[..close_pos];
    let open_pos = prefix.rfind(OPEN)?;
    let inner = &prefix[open_pos + OPEN.len()..];
    let trimmed = inner.trim();
    if trimmed.is_empty() {
        return None;
    }
    serde_json::from_str(trimmed).ok()
}

/// 构造质量门提示词：候选数组 + 技能路径 + 输出格式。
fn build_gate_prompt(
    target: &KnowledgeTarget,
    indices: &[usize],
    all: &[KnowledgeCandidate],
) -> String {
    let payload: Vec<serde_json::Value> = indices
        .iter()
        .map(|&i| {
            let c = &all[i];
            serde_json::json!({
                "index": i,
                "module": c.module,
                "section": c.section,
                "content": c.content,
                "evidence": c.evidence,
                "confidence": c.confidence,
                "suggestedTitle": c.suggested_title,
            })
        })
        .collect();
    format!(
        r#"你是知识质量门。请先读取并严格遵循 `{skill_dir}/SKILL.md` 中的「回写质量门」规则。
当前工作目录是通用知识图谱技能目录：{skill_dir}

待校验候选（index 为原始序号，务必原样带回）：
{payload}

请对照 `{target_id}/data/modules/<module>.md` 的现有内容逐条校验，只输出：
<GATE>
[{{"index":0,"passed":true,"reason":"ok"}}]
</GATE>
标签外不要输出任何内容。passed=false 时 reason 必须给出具体依据（重复 / 冲突 / 依据不足等）。"#,
        skill_dir = target.skill_dir,
        target_id = target.id,
        payload = serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

/// 在 section 末尾追加一条结构化知识块（只增不改），返回新文件内容。
fn append_entry(content: &str, section: &str, candidate: &KnowledgeCandidate) -> String {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    if !content.ends_with('\n') {
        lines.push(String::new());
    }
    let borrowed: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    let heading = find_section_heading(&borrowed, section).expect("validated section heading");
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
    block.push(format!("- {date} · 已确认 · {}", candidate.content.trim()));
    block.push(format!("  - 依据：{}", candidate.evidence.trim()));
    if end < lines.len() && lines[end].starts_with("## ") {
        block.push(String::new());
    }
    lines.splice(end..end, block);
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 知识沉淀自动回写：规则校验 → Agent 质量门 → 写模块卡片 → git 提交推送。
/// 返回逐条结果；任何一条未通过都不会写库，由前端保留议题走人工审核。
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
    let target = resolve_knowledge_target(project_path).await?;
    let _write_guard = lock_graph(&target.id).await;
    let hub_str = Path::new(&target.skill_dir)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| "无法定位技能库根目录".to_string())?;
    let _hub = PathBuf::from(&hub_str);

    // 1) 规则层：逐条结构校验，不通过直接出局（不进 Agent）。
    let mut items: Vec<KnowledgeWritebackItem> = Vec::new();
    let mut rule_passed: Vec<usize> = Vec::new();
    for (index, candidate) in suggestions.iter().enumerate() {
        let item = match validate_candidate(&target, candidate) {
            Ok(_) => {
                rule_passed.push(index);
                KnowledgeWritebackItem {
                    index,
                    module: candidate.module.clone(),
                    section: candidate.section.clone(),
                    passed: true,
                    written: false,
                    reason: String::new(),
                }
            }
            Err(reason) => KnowledgeWritebackItem {
                index,
                module: candidate.module.clone(),
                section: candidate.section.clone(),
                passed: false,
                written: false,
                reason,
            },
        };
        items.push(item);
    }

    // 2) Agent 层：一次 headless 批量语义质检。
    if !rule_passed.is_empty() {
        let prompt = build_gate_prompt(&target, &rule_passed, &suggestions);
        let output = crate::agent_assist::run_headless_agent_with_timeout(
            &agent,
            &hub_str,
            &prompt,
            QUALITY_GATE_TIMEOUT,
            true,
            None,
        )
        .await?;
        if !output.status.success() {
            return Err(format!(
                "质量门执行失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let verdicts = parse_gate_verdicts(&stdout).ok_or_else(|| {
            "质量门未返回 <GATE> 结果，按全部未通过处理（议题保留人工审核）".to_string()
        })?;
        let judged: Vec<usize> = verdicts.iter().map(|v| v.index).collect();
        for verdict in verdicts {
            if let Some(item) = items.iter_mut().find(|i| i.index == verdict.index) {
                item.passed = verdict.passed;
                if !verdict.passed {
                    item.reason = if verdict.reason.is_empty() {
                        "质量门未通过".to_string()
                    } else {
                        verdict.reason
                    };
                }
            }
        }
        // 质量门漏判的条目一律按未通过处理，绝不让「漏回」变成放行。
        for item in items.iter_mut() {
            if rule_passed.contains(&item.index) && !judged.contains(&item.index) {
                item.passed = false;
                item.reason = "质量门未返回该条判定，按未通过处理".to_string();
            }
        }
    }

    // 3) 写入通过的条目（同模块多次写入按顺序累积）。
    let mut changed_docs: Vec<PathBuf> = Vec::new();
    for (index, candidate) in suggestions.iter().enumerate() {
        let passed = items
            .iter()
            .find(|i| i.index == index)
            .map(|i| i.passed)
            .unwrap_or(false);
        if !passed {
            continue;
        }
        if module_card_has_uncommitted_changes(&target, &candidate.module).await? {
            if let Some(item) = items.iter_mut().find(|i| i.index == index) {
                item.passed = false;
                item.written = false;
                item.reason = "目标模块卡片存在未提交人工修改".to_string();
            }
            continue;
        }
        let doc = module_doc_path(&target, &candidate.module);
        let current = std::fs::read_to_string(&doc)
            .map_err(|e| format!("写入前读取 {} 失败: {e}", candidate.module))?;
        let next = append_entry(&current, &candidate.section, candidate);
        std::fs::write(&doc, next).map_err(|e| format!("写入 {} 失败: {e}", candidate.module))?;
        if !changed_docs.contains(&doc) {
            changed_docs.push(doc);
        }
        if let Some(item) = items.iter_mut().find(|i| i.index == index) {
            item.written = true;
            item.reason = "已自动写入模块卡片".to_string();
        }
    }

    // 4) git 提交推送（有写入才提交）。
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
            hub_str.clone(),
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
        let message = format!("docs(knowledge): auto sediment {written_count} entries via Nezha");
        let commit_out = crate::git::run_git_with_timeout(
            hub_str.clone(),
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
            hub_str.clone(),
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
        let next = append_entry(&sample_doc(), &candidate.section, &candidate);
        let in_section = next
            .split("## 业务规则 / 已知坑")
            .nth(1)
            .and_then(|rest| rest.split("## 验证记录").next())
            .unwrap_or_default();
        assert!(in_section.contains("缓存键必须带租户前缀"));
        assert!(in_section.contains("依据：Hsp.BaseData.Cache.Bll/CacheService.cs:42"));
        // 只增不改：原有内容仍在。
        assert!(next.contains("（待补充）"));
    }

    #[test]
    fn parses_gate_verdict_block() {
        let stdout = "前言\n<GATE>[{\"index\":0,\"passed\":true,\"reason\":\"ok\"},{\"index\":1,\"passed\":false,\"reason\":\"与现状冲突\"}]</GATE>\n后记";
        let verdicts = parse_gate_verdicts(stdout).expect("parses");
        assert_eq!(verdicts.len(), 2);
        assert!(verdicts[0].passed);
        assert_eq!(verdicts[1].reason, "与现状冲突");
    }
}
