import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 轮询间隔：图谱待确认数只需近实时，10s 足够且开销极低（一次 git status）。 */
const POLL_MS = 10_000;

/**
 * 项目绑定图谱的「待确认卡片数」——右侧工具条知识库图标红点用。
 *
 * 刻意独立于 `KnowledgePanel` 挂载：面板关闭时也必须有红点提醒，否则「有内容待发布」
 * 会在用户没打开面板时完全不可见（这正是本需求要解决的问题）。
 *
 * 未绑定图谱 / 读配置失败一律回落 0，不报错——红点缺失不应影响页面。
 */
export function useKnowledgePending(projectPath: string): number {
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const config = await invoke<{ knowledge?: { graph_id?: string } }>(
          "read_project_config",
          { projectPath },
        );
        const graphId = config.knowledge?.graph_id ?? "";
        if (!graphId) {
          if (!cancelled) setPending(0);
          return;
        }
        const count = await invoke<number>("count_pending_knowledge_cards", { graphId });
        if (!cancelled) setPending(count);
      } catch {
        if (!cancelled) setPending(0);
      }
    };

    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    // 沉淀完成 / 技能仓库同步（提交推送会清空未提交态）后立即刷新，不必等下一轮轮询。
    const unlisten = listen("skill-hub-changed", () => void refresh()).catch(() => null);
    const unlisten2 = listen("knowledge-sedimentation", () => void refresh()).catch(() => null);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      unlisten.then((fn) => fn?.());
      unlisten2.then((fn) => fn?.());
    };
  }, [projectPath]);

  return pending;
}
