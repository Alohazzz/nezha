import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { CornerDownLeft, ImagePlus, Square, Zap } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  BUILTIN_COMMANDS,
  ComposerMentionPopover,
  useComposerMention,
  type MentionItem,
} from "../new-task/ComposerMention";
import { CodexModelPicker } from "./CodexModelPicker";
import { ImageAttachments } from "../new-task/ImageAttachments";
import { expandSkillTokens } from "../../skillMention";
import type { AgentModelCatalog } from "../app-settings/types";
import {
  composerCanSend,
  extractImageFiles,
  fileToDataUrl,
  makeImageId,
  MAX_IMAGE_DATA_URL_LENGTH,
  type ComposerImage,
} from "./composerImages";
import { acceptPrediction, PredictionGhost } from "./PredictionGhost";
import { usePromptPrediction } from "./usePromptPrediction";

/** IME 组合中的按键（含 keyCode 229 的 legacy 报法）一律不当作提交/中断指令。 */
const isImeComposing = (e: React.KeyboardEvent) =>
  e.nativeEvent.isComposing || e.keyCode === 229;

export const CodexComposer = memo(function CodexComposer({
  taskId, threadId, predictionEligible, predictionFingerprint,
  mode,
  busy,
  disabled,
  projectPath,
  modelCatalog,
  model,
  reasoningEffort,
  showModelBadge,
  onSubmit,
  onSetModel,
  onSetEffort,
  onBuiltinAction,
  onToast,
}: {
  /** running = steer 语义（追加进当前 turn）；其余 = resume 语义（新 turn）。 */
  taskId?: string;
  threadId?: string;
  predictionEligible?: boolean;
  predictionFingerprint?: string;
  mode: "steer" | "resume";
  busy?: boolean;
  disabled?: boolean;
  /** 项目根路径：`@` 文件引用与 `/` 项目级命令的数据来源。 */
  projectPath?: string;
  /** `/model` `/effort` 选择器的目录来源（应用级 codex_model_catalog）。 */
  modelCatalog?: AgentModelCatalog;
  /** 当前会话级模型 / 推理深度（回显与选中态）。 */
  model?: string;
  reasoningEffort?: string;
  /** footer 是否显示当前模型徽标（structured 任务才开）。 */
  showModelBadge?: boolean;
  onSubmit: (text: string, images: string[]) => void;
  /** 内置命令写入上抛；缺省 = 不注入 /model /effort（PTY 等旧调用方）。 */
  onSetModel?: (model: string | undefined) => void;
  onSetEffort?: (effort: string | undefined) => void;
  /** 非选择器类内置命令动作上抛（/compact /review /stop；App 层落 RPC）。
   *  缺省时这三项命令仍列出但选中无效果（保守：不注入会误导）。 */
  onBuiltinAction?: (action: "compact" | "review" | "stop") => void;
  /** 图片被拒收（超限等）时的提示通道；缺省静默跳过。 */
  onToast?: (message: string, kind: "warning" | "error") => void;
}) {
  const { t } = useI18n();
  const prediction = usePromptPrediction(taskId, threadId, predictionEligible === true, predictionFingerprint);
  const suppressPrediction = prediction.suppress;
  const descriptionId = useId();
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [focused, setFocused] = useState(false);
  const [slashPicker, setSlashPicker] = useState<"models" | "efforts" | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef("");
  textRef.current = text;
  const imagesRef = useRef<ComposerImage[]>([]);
  imagesRef.current = images;

  const canSend = composerCanSend({ disabled, busy, text, imageCount: images.length });
  const inputsLocked = disabled || busy;
  // 运行中（steer 模式）且输入未被锁（审批挂起时不受理中断，审批卡优先）
  const canStop = mode === "steer" && !inputsLocked;

  // 内置命令只在宿主提供了写入通道时注入（旧调用方维持原行为）。
  // /compact /review /stop 仅运行中有意义；done 态注入但选中时提示不可用。
  const builtin = onSetModel
    ? BUILTIN_COMMANDS.map(({ name, action }) => ({
        name,
        description: t(
          action === "picker:model"
            ? "composer.builtin.model"
            : action === "picker:effort"
              ? "composer.builtin.effort"
              : action === "rpc:compact"
                ? "composer.builtin.compact"
                : action === "rpc:review"
                  ? "composer.builtin.review"
                  : "composer.builtin.stop",
        ),
      }))
    : undefined;

  const mention = useComposerMention(
    inputRef,
    textRef,
    useCallback((next: string) => {
      suppressPrediction();
      setText(next);
    }, [suppressPrediction]),
    projectPath ?? null,
    builtin,
  );

  /** 选中候选项：builtin 走对应动作（选择器/RPC/中断），其余展开文本。 */
  const handleSelectItem = useCallback(
    (item: MentionItem) => {
      if (item.kind === "builtin" && onSetModel) {
        mention.close();
        setText("");
        const action = BUILTIN_COMMANDS.find((cmd) => cmd.name === item.name)?.action;
        if (action === "picker:effort") {
          setSlashPicker("efforts");
        } else if (action === "rpc:compact") {
          onBuiltinAction?.("compact");
        } else if (action === "rpc:review") {
          onBuiltinAction?.("review");
        } else if (action === "stop") {
          onBuiltinAction?.("stop");
        } else {
          setSlashPicker("models");
        }
        return;
      }
      mention.applyItem(item);
    },
    [mention, onSetModel, onBuiltinAction],
  );

  // 自适应高度：输入增长时撑到上限后内部滚动（Paseo composer 同款行为）
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [text, autoResize]);

  // Ctrl+L / Cmd+L 聚焦输入框（Paseo 的 message-input.action 同款快捷键）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const addImageFiles = useCallback(
    (files: File[]) => {
      // busy/disabled 期间显式忽略（spec：审批挂起等场景粘贴与选择均不生效）；
      // textarea disabled 只挡粘贴，文件选择对话框是独立入口。
      if (inputsLocked || files.length === 0) return;
      suppressPrediction();
      for (const file of files) {
        void fileToDataUrl(file).then((dataUrl) => {
          if (!dataUrl) return;
          if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
            onToast?.(t("codex.composer.imageTooLarge"), "warning");
            return;
          }
          setImages((prev) => [...prev, { id: makeImageId(), dataUrl }]);
        });
      }
    },
    [inputsLocked, onToast, t, suppressPrediction],
  );

  /** 粘贴：图片 items 归附件（不进文本框）；其余保持 textarea 默认行为。 */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = extractImageFiles(e.clipboardData.items);
      if (files.length === 0) return;
      e.preventDefault();
      addImageFiles(files);
    },
    [addImageFiles],
  );

  const submit = () => {
    if (!canSend) return;
    const imageUrls = imagesRef.current.map((img) => img.dataUrl);
    // 输入框里是紧凑的 `$skill` 引用，提交这一刻才展开成带 SKILL.md 路径的指令，
    // agent 收到的提示词与改动前逐字一致。
    onSubmit(expandSkillTokens(text, mention.skills).trim(), imageUrls);
    setText("");
    setImages([]);
    mention.close();
    autoResize();
  };

  /** 中断当前 turn（/stop 同一通道）：App 层落 `interrupt_codex_structured`。 */
  const stopTurn = useCallback(() => {
    if (!canStop) return;
    onBuiltinAction?.("stop");
  }, [canStop, onBuiltinAction]);

  const placeholder =
    mode === "steer"
      ? busy
        ? t("codex.composer.steering")
        : t("codex.composer.placeholderRunning")
      : t("codex.composer.placeholderDone");

  const visiblePrediction = !text && !images.length && !inputsLocked && !composing && !mention.active && !slashPicker ? prediction.suggestion : null;

  return (
    <div className="nz-codexComposerWrap">
      <ComposerMentionPopover
        visible={mention.active}
        trigger={mention.trigger}
        query={mention.query}
        items={mention.items}
        loading={mention.loading}
        index={mention.index}
        onSetIndex={mention.setIndex}
        onSelect={handleSelectItem}
      />
      {slashPicker && onSetModel && modelCatalog && (
        <CodexModelPicker
          view={slashPicker}
          catalog={modelCatalog}
          model={model}
          reasoningEffort={reasoningEffort}
          onClose={() => {
            setSlashPicker(null);
            inputRef.current?.focus();
          }}
          onSetModel={onSetModel}
          onSetEffort={onSetEffort ?? (() => {})}
        />
      )}
      <div className="nz-codexComposerBox" data-focused={focused}>
        <div className="codex-prediction-input-wrap" data-prediction-enabled={predictionEligible === true}>
        <PredictionGhost suggestion={visiblePrediction} focused={focused} descriptionId={descriptionId} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          aria-label={placeholder}
          aria-describedby={visiblePrediction ? descriptionId : undefined}
          placeholder={visiblePrediction ? "" : placeholder}
          onCompositionStart={() => { setComposing(true); suppressPrediction(); }}
          onCompositionEnd={() => setComposing(false)}
          disabled={inputsLocked}
          className="nz-codexComposerInput"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            suppressPrediction();
            setText(e.target.value);
            mention.syncFromCaret(e.target.selectionStart);
            // 高度自适应交给 useEffect([text])：autoResize 是强制 reflow
            //（height=0 → 读 scrollHeight），onChange 里同步再跑一次等于每次
            // 按键双倍 layout，快打时与回显争抢主线程。
          }}
          onClick={(e) => mention.syncFromCaret(e.currentTarget.selectionStart)}
          onPaste={(event) => { suppressPrediction(); handlePaste(event); }}
          onKeyDown={(e) => {
            // IME takes priority over both predictions and mention navigation.
            if (composing || isImeComposing(e)) {
              suppressPrediction();
              return;
            }
            if (acceptPrediction(e, visiblePrediction)) {
              suppressPrediction();
              setText(e.currentTarget.value);
              return;
            }
            // 快捷召唤弹层的键盘导航优先于提交
            if (mention.handleKeyDown(e)) return;
            // ESC 中断当前 turn（PTY 终端按 ESC 打断的同款直觉）：仅运行中且
            // 无弹层受理时生效；斜杠/提及弹层开着时 ESC 归弹层关闭。
            if (e.key === "Escape" && canStop && !mention.active) {
              e.preventDefault();
              stopTurn();
              return;
            }
            // Enter 发送 / Shift+Enter 换行（与全局 sendShortcut 默认一致）
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        </div>
        {images.length > 0 && (
          <div className="nz-codexComposerAttachments">
            <ImageAttachments
              images={images}
              onRemove={(id) => setImages((prev) => prev.filter((img) => img.id !== id))}
            />
          </div>
        )}
        <div className="nz-codexComposerFooter">
          <span className="nz-codexComposerHint">
            {mode === "steer" ? t("codex.composer.hintSteer") : t("codex.composer.hintResume")}
          </span>
          {showModelBadge && onSetModel && (
            <>
              <button
                type="button"
                className="nz-codexComposerModelBadge"
                title={t("newTask.model")}
                onClick={() => setSlashPicker("models")}
              >
                <Zap size={11} strokeWidth={2.2} fill="currentColor" className="nz-taskModelCompactIcon" />
                <span className="nz-codexComposerModelBadgeName">
                  {model ?? t("newTask.modelDefault")}
                </span>
              </button>
              <button
                type="button"
                className="nz-codexComposerModelBadge"
                title={t("newTask.reasoningEffort")}
                onClick={() => setSlashPicker("efforts")}
              >
                <span className="nz-codexComposerModelBadgeName">
                  {reasoningEffort ?? t("newTask.reasoningEffortAuto")}
                </span>
              </button>
            </>
          )}
          <button
            type="button"
            disabled={inputsLocked}
            className="nz-codexComposerAddImageBtn"
            onClick={() => fileInputRef.current?.click()}
            title={t("codex.composer.addImage")}
          >
            <ImagePlus size={15} strokeWidth={2} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            hidden
            onChange={(e) => {
              suppressPrediction();
              addImageFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <span className="nz-codexComposerFocusHint">
            {canStop ? t("codex.composer.stopHint") : "Ctrl+L"}
          </span>
          {canStop && (
            <button
              type="button"
              className="codex-stream-stop-btn nz-codexComposerStopBtn"
              onClick={stopTurn}
              title={t("codex.composer.stop")}
            >
              <Square size={11} strokeWidth={2.6} fill="currentColor" />
              <span>{t("codex.composer.stop")}</span>
            </button>
          )}
          <button
            type="button"
            disabled={!canSend}
            className="nz-codexComposerSendBtn"
            onClick={submit}
            title={t("codex.followUp.send")}
          >
            <span>{t("codex.followUp.send")}</span>
            <CornerDownLeft size={12} strokeWidth={2.3} />
          </button>
        </div>
      </div>
    </div>
  );
});
