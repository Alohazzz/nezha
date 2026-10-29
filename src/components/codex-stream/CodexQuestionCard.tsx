import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronUp, HelpCircle, Send } from "lucide-react";
import type { CodexUserInputQuestion, CodexUserInputRequest } from "../../types";
import { useI18n } from "../../i18n";

/**
 * 模型提问卡片：结构化流底部 sticky 面板，逐题选/填后一次提交。
 *
 * 数据来自 Codex 的 `request_user_input` 工具调用（反向请求
 * `item/tool/requestUserInput`），与 ZCode 的 AskUserQuestion 同构：
 * 每题 `header` 芯片 + `question` + 互斥 `options`，另附「其他」自由输入。
 *
 * 两个必须守住的行为：
 * - **答题要回传**：core 侧是 `rx_response.await`，应答之前 turn 一直挂着；
 *   用户点「跳过」也要回空 answers，不能只是把卡片藏起来——所以收起态的
 *   标题条上仍保留「跳过」。
 * - **题目数量不设上限**：上游建议 1~3 题，但模型可能一次列更多，所以
 *   展开态 body 滚动、卡片最高 50vh；整卡可收起成一行标题条，不挡会话内容。
 *
 * 「其他」输入：带选项的题默认不渲染输入框，点选项列表末尾的「其他…」
 * 伪选项才展开（点开即清掉已选选项，互斥语义不变）；无选项的题输入框
 * 是唯一作答路径，保持常驻。
 */
export function CodexQuestionCard({
  request,
  onResolved,
  onError,
}: {
  request: CodexUserInputRequest;
  onResolved: () => void;
  onError?: (message: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  /** 每题一条选择：有 options 时存 label，自由输入时存原文。 */
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [others, setOthers] = useState<Record<string, string>>({});
  /** 带选项的题：点「其他…」伪选项后才出现的自由输入框。 */
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  /** 折叠态只挂本卡片生命周期：新请求（request_id 变化）到达时强制重新展开。 */
  const [collapsed, setCollapsed] = useState(false);

  // 同一请求内用户收起后保持收起；换了请求（新提问）自动展开。
  useEffect(() => {
    setCollapsed(false);
  }, [request.request_id]);

  const questions = useMemo(() => request.questions ?? [], [request.questions]);

  const pick = useCallback((questionId: string, label: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: [label] }));
    setOthers((prev) => {
      if (!(questionId in prev)) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  }, []);

  const typeOther = useCallback((questionId: string, text: string) => {
    setOthers((prev) => ({ ...prev, [questionId]: text }));
    setAnswers((prev) => {
      const next = { ...prev };
      if (text.trim()) next[questionId] = [text];
      else delete next[questionId];
      return next;
    });
  }, []);

  /** 点「其他…」伪选项：展开输入框并清掉已选选项（互斥语义不变）。 */
  const openOther = useCallback((questionId: string) => {
    setOtherOpen((prev) => ({ ...prev, [questionId]: true }));
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
    setOthers((prev) => {
      if (questionId in prev) return prev;
      return { ...prev, [questionId]: "" };
    });
  }, []);

  const respond = useCallback(
    async (payload: Record<string, string[]>) => {
      if (busy) return;
      setBusy(true);
      try {
        await invoke("respond_codex_user_input", {
          taskId: request.task_id,
          requestId: request.request_id,
          answers: payload,
        });
        onResolved();
      } catch (err) {
        console.error("respond_codex_user_input failed", err);
        onError?.(typeof err === "string" ? err : String(err));
        setBusy(false);
      }
    },
    [busy, onError, onResolved, request.request_id, request.task_id],
  );

  // 只提交真正答了的题：没选的题留空，后端按问题 id 过滤后等价于该题未答。
  const submit = useCallback(() => {
    const payload: Record<string, string[]> = {};
    for (const question of questions) {
      const values = answers[question.id];
      if (values && values.length > 0) payload[question.id] = values;
    }
    void respond(payload);
  }, [answers, questions, respond]);

  const answeredCount = questions.filter((q) => (answers[q.id]?.length ?? 0) > 0).length;
  const canSubmit = answeredCount > 0;

  const toggleCollapsed = useCallback(() => setCollapsed((prev) => !prev), []);

  return (
    <div className="codex-question-card" data-collapsed={collapsed || undefined}>
      <button
        type="button"
        className="codex-question-header"
        onClick={toggleCollapsed}
        title={collapsed ? t("codex.question.expand") : t("codex.question.collapse")}
      >
        <HelpCircle size={13} />
        <span>{t("codex.question.title")}</span>
        {questions.length > 1 && (
          <span className="codex-question-counter">
            {t("codex.question.progress", {
              answered: String(answeredCount),
              total: String(questions.length),
            })}
          </span>
        )}
        {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {collapsed ? (
        <div className="codex-question-collapsed-bar">
          <button
            type="button"
            className="skip"
            disabled={busy}
            onClick={() => void respond({})}
          >
            <span>{t("codex.question.skip")}</span>
          </button>
        </div>
      ) : (
        <>
          <div className="codex-question-body">
            {questions.map((question) => (
              <QuestionRow
                key={question.id}
                question={question}
                selected={answers[question.id] ?? []}
                otherValue={others[question.id] ?? ""}
                otherOpen={otherOpen[question.id] ?? false}
                busy={busy}
                onPick={pick}
                onTypeOther={typeOther}
                onOpenOther={openOther}
              />
            ))}
          </div>
          <div className="codex-question-actions">
            <button
              type="button"
              className="submit"
              disabled={busy || !canSubmit}
              onClick={submit}
            >
              <Send size={12} strokeWidth={2.5} />
              <span>{t("codex.question.submit")}</span>
            </button>
            <button
              type="button"
              className="skip"
              disabled={busy}
              onClick={() => void respond({})}
            >
              <span>{t("codex.question.skip")}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QuestionRow({
  question,
  selected,
  otherValue,
  otherOpen,
  busy,
  onPick,
  onTypeOther,
  onOpenOther,
}: {
  question: CodexUserInputQuestion;
  selected: string[];
  otherValue: string;
  /** 带选项的题：自由输入框是否已通过「其他…」伪选项展开。 */
  otherOpen: boolean;
  busy: boolean;
  onPick: (questionId: string, label: string) => void;
  onTypeOther: (questionId: string, text: string) => void;
  onOpenOther: (questionId: string) => void;
}) {
  const { t } = useI18n();
  const options = question.options ?? [];
  // 无选项的题（纯自由文本/密码）没有可点选的目标，输入框是唯一作答路径。
  const freeForm = options.length === 0;
  const isOtherActive = otherValue.trim().length > 0;
  const showOtherInput = freeForm || otherOpen;

  return (
    <div className="codex-question-row">
      <div className="codex-question-chip">{question.header}</div>
      <div className="codex-question-text">{question.question}</div>
      {options.length > 0 && (
        <div className="codex-question-options">
          {options.map((option) => {
            const active = !isOtherActive && selected.includes(option.label);
            // 推荐项排第一由模型负责标注；这里只把 "(Recommended)" 后缀渲染成
            // 弱化标签，避免长标签把选项行撑爆。
            const recommended = /\(Recommended\)$/i.test(option.label);
            const label = recommended
              ? option.label.replace(/\s*\(Recommended\)$/i, "")
              : option.label;
            return (
              <button
                key={option.label}
                type="button"
                className="codex-question-option"
                data-active={active || undefined}
                disabled={busy}
                onClick={() => onPick(question.id, option.label)}
              >
                <span className="label">
                  {label}
                  {recommended && (
                    <span className="badge">{t("codex.question.recommended")}</span>
                  )}
                </span>
                {option.description && (
                  <span className="description">{option.description}</span>
                )}
              </button>
            );
          })}
          {/* 「其他」收进伪选项：默认不占一行，点开后与选项互斥。 */}
          {!otherOpen && (
            <button
              type="button"
              className="codex-question-option other"
              data-active={isOtherActive || undefined}
              disabled={busy}
              onClick={() => onOpenOther(question.id)}
            >
              <span className="label">{t("codex.question.other")}</span>
            </button>
          )}
        </div>
      )}
      {showOtherInput && (
        <input
          type={question.isSecret ? "password" : "text"}
          className="codex-question-other"
          data-active={isOtherActive || undefined}
          placeholder={t("codex.question.otherPlaceholder")}
          value={otherValue}
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          autoFocus={!freeForm}
          onChange={(e) => onTypeOther(question.id, e.target.value)}
        />
      )}
    </div>
  );
}
