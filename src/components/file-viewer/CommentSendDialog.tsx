import { useState } from "react";
import * as Select from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { STATUS_LABEL, type Task } from "../../types";
import s from "../../styles";
import { useI18n } from "../../i18n";
import { isSendableStatus } from "./reviewComments";

export type SendMode = "direct" | "resume" | "new";

/** 发送对话框只依赖评论的 id + 正文；标签由调用方通过 labelFor 提供。 */
type SendableComment = { id: string; text: string };

/**
 * 发送对话框（决策 9 + R3）：
 * - 默认目标 = 自动判定的当前活跃任务（awaiting_review → input_required → running → 最近活跃），可下拉改选
 * - 目标存活：直接发送；running 中发送需确认打断
 * - 目标已结束：提供「恢复会话再发 / 作为新任务发」双选项
 */
export function CommentSendDialog<T extends SendableComment>({
  comments,
  labelFor,
  tasks,
  defaultTaskId,
  allowNewTask = false,
  onClose,
  onSend,
}: {
  comments: T[];
  /** 每条评论在对话框里的定位描述（如 `路径:行号` / 模块名）。 */
  labelFor: (comment: T) => string;
  tasks: Task[];
  defaultTaskId: string | null;
  /** 即使目标任务仍存活也展示「作为新任务发」（知识库修改等跨仓库写入场景）。 */
  allowNewTask?: boolean;
  onClose: () => void;
  onSend: (taskId: string, mode: SendMode) => void;
}) {
  const { t } = useI18n();
  const [taskId, setTaskId] = useState<string>(() => defaultTaskId ?? tasks[0]?.id ?? "");
  const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
  const live = task ? isSendableStatus(task.status) : false;
  const isRunning = task?.status === "running";

  const handleDirectSend = async () => {
    if (!task) return;
    if (isRunning) {
      const ok = await confirm(t("reviewComments.confirmInterrupt"), {
        title: t("reviewComments.confirmInterruptTitle"),
        kind: "warning",
      });
      if (!ok) return;
    }
    onSend(task.id, "direct");
  };

  return (
    <div style={s.rcSendBackdrop} onPointerDown={onClose}>
      <div style={s.rcSendDialog} onPointerDown={(event) => event.stopPropagation()}>
        <div style={s.rcSendTitle}>{t("reviewComments.sendTitle")}</div>
        <div style={s.rcSendField}>
          <label style={s.rcSendFieldLabel}>{t("reviewComments.targetTask")}</label>
          {tasks.length === 0 ? (
            <div style={s.rcSendHint}>{t("reviewComments.noTargetTask")}</div>
          ) : (
            <Select.Root value={taskId} onValueChange={setTaskId}>
              <Select.Trigger style={s.rcSendTargetTrigger} aria-label={t("reviewComments.targetTask")}>
                <Select.Value />
                <Select.Icon>
                  <ChevronDown size={13} />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content position="popper" sideOffset={6} style={s.rcSendTargetContent}>
                  <Select.Viewport>
                    {tasks.map((candidate) => (
                      <Select.Item
                        key={candidate.id}
                        value={candidate.id}
                        style={{
                          ...s.rcSendTargetItem,
                          ...(candidate.id === taskId ? s.rcSendTargetItemSelected : null),
                        }}
                      >
                        <Select.ItemText>
                          {candidate.name ?? candidate.prompt.slice(0, 40)}
                          {" · "}
                          {candidate.agent}
                          {" · "}
                          {STATUS_LABEL[candidate.status]}
                        </Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          )}
        </div>
        <div style={s.rcSendField}>
          <label style={s.rcSendFieldLabel}>
            {t("reviewComments.willSend", { count: comments.length })}
          </label>
          <div style={s.rcSendCommentList}>
            {comments.map((comment) => (
              <div key={comment.id} style={s.rcSendCommentLoc} title={comment.text}>
                {labelFor(comment)} — {comment.text.slice(0, 60)}
              </div>
            ))}
          </div>
        </div>
        {task && !live && (
          <div style={s.rcSendHintWarning}>{t("reviewComments.taskEndedHint")}</div>
        )}
        {task && live && isRunning && (
          <div style={s.rcSendHintWarning}>{t("reviewComments.runningHint")}</div>
        )}
        <div style={s.rcSendActions}>
          <button type="button" style={s.rcSendBtnSecondary} onClick={onClose}>
            {t("reviewComments.cancel")}
          </button>
          {task && live ? (
            <button type="button" style={s.rcSendBtnPrimary} onClick={() => void handleDirectSend()}>
              {t("reviewComments.send")}
            </button>
          ) : null}
          {task && live && allowNewTask ? (
            <button
              type="button"
              style={s.rcSendBtnPrimary}
              onClick={() => onSend(task.id, "new")}
            >
              {t("reviewComments.newTaskSend")}
            </button>
          ) : null}
          {task && !live ? (
            <>
              <button
                type="button"
                style={s.rcSendBtnSecondary}
                onClick={() => onSend(task.id, "resume")}
              >
                {t("reviewComments.resumeAndSend")}
              </button>
              <button
                type="button"
                style={s.rcSendBtnPrimary}
                onClick={() => onSend(task.id, "new")}
              >
                {t("reviewComments.newTaskSend")}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
