import { useCallback, useEffect, useRef, useState } from "react";
import { CornerDownLeft, ImagePlus, Zap } from "lucide-react";
import { useI18n } from "../../i18n";
import {
  BUILTIN_COMMAND_NAMES,
  ComposerMentionPopover,
  useComposerMention,
  type MentionItem,
} from "../new-task/ComposerMention";
import { CodexModelPicker } from "./CodexModelPicker";
import { ImageAttachments } from "../new-task/ImageAttachments";
import type { AgentModelCatalog } from "../app-settings/types";
import {
  composerCanSend,
  extractImageFiles,
  fileToDataUrl,
  makeImageId,
  MAX_IMAGE_DATA_URL_LENGTH,
  type ComposerImage,
} from "./composerImages";
import s from "../../styles";

/**
 * structured 任务的常驻底部 composer（Paseo 式会话框的核心形态）：
 * - 任何状态都渲染——运行中提交 = `steer_codex_structured`（turn/steer 追加指令，
 *   当前 turn 不中断）；done 态提交 = `resume_codex_structured`（thread/resume 新 turn）。
 * - Enter 发送 / Shift+Enter 换行；Ctrl+L 聚焦（focus hint 同 Paseo）。
 * - 快捷召唤：`$` 技能 / `/` 命令（含内置 /model /effort）/ `@` 项目文件。
 *   内置命令选中不开选择器浮层（CodexModelPicker），写入经 onSetModel/onSetEffort
 *   上抛（App 层调 set_codex_structured_model + 持久化任务快照）。
 * - 图片附件（issue #118）：粘贴 / 文件选择 → 缩略图预览可移除；纯图片可发送
 *   （交互对齐 ZCode 与 NewTaskView）。dataUrl 随提交上抛，落盘在后端。
 * - 提交后本地乐观用户气泡由调用方（App 层）负责插入。
 */
export function CodexComposer({
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
  onToast,
}: {
  /** running = steer 语义（追加进当前 turn）；其余 = resume 语义（新 turn）。 */
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
  /** 图片被拒收（超限等）时的提示通道；缺省静默跳过。 */
  onToast?: (message: string, kind: "warning" | "error") => void;
}) {
  const { t } = useI18n();
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

  // 内置命令只在宿主提供了写入通道时注入（旧调用方维持原行为）
  const builtin = onSetModel
    ? BUILTIN_COMMAND_NAMES.map((name) => ({
        name,
        description: t(name === "model" ? "composer.builtin.model" : "composer.builtin.effort"),
      }))
    : undefined;

  const mention = useComposerMention(
    inputRef,
    textRef,
    useCallback((next: string) => {
      setText(next);
    }, []),
    projectPath ?? null,
    builtin,
  );

  /** 选中候选项：builtin 走选择器浮层，其余展开文本。 */
  const handleSelectItem = useCallback(
    (item: MentionItem) => {
      if (item.kind === "builtin" && onSetModel) {
        mention.close();
        setText("");
        setSlashPicker(item.name === "model" ? "models" : "efforts");
        return;
      }
      mention.applyItem(item);
    },
    [mention, onSetModel],
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
    [inputsLocked, onToast, t],
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
    onSubmit(text.trim(), imageUrls);
    setText("");
    setImages([]);
    mention.close();
    autoResize();
  };

  const placeholder =
    mode === "steer"
      ? busy
        ? t("codex.composer.steering")
        : t("codex.composer.placeholderRunning")
      : t("codex.composer.placeholderDone");

  return (
    <div style={{ ...s.codexComposerWrap, position: "relative" } as React.CSSProperties}>
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
      <div style={{ ...s.codexComposerBox, ...(focused ? s.codexComposerBoxFocused : {}) }}>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          disabled={inputsLocked}
          style={s.codexComposerInput}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            mention.syncFromCaret(e.target.selectionStart);
            autoResize();
          }}
          onClick={(e) => mention.syncFromCaret(e.currentTarget.selectionStart)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // 快捷召唤弹层的键盘导航优先于提交
            if (mention.handleKeyDown(e)) return;
            // Enter 发送 / Shift+Enter 换行（与全局 sendShortcut 默认一致）
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {images.length > 0 && (
          <div style={s.codexComposerAttachments}>
            <ImageAttachments
              images={images}
              onRemove={(id) => setImages((prev) => prev.filter((img) => img.id !== id))}
            />
          </div>
        )}
        <div style={s.codexComposerFooter}>
          <span style={s.codexComposerHint}>
            {mode === "steer" ? t("codex.composer.hintSteer") : t("codex.composer.hintResume")}
          </span>
          {showModelBadge && onSetModel && (
            <button
              type="button"
              style={s.codexComposerModelBadge}
              title={t("newTask.model")}
              onClick={() => setSlashPicker("models")}
            >
              <Zap size={11} strokeWidth={2.2} fill="currentColor" style={s.taskModelCompactIcon} />
              <span style={s.codexComposerModelBadgeName}>
                {model ?? t("newTask.modelDefault")}
              </span>
              {reasoningEffort && (
                <span style={s.codexComposerModelBadgeEffort}>{reasoningEffort}</span>
              )}
            </button>
          )}
          <button
            type="button"
            disabled={inputsLocked}
            style={{
              ...s.codexComposerAddImageBtn,
              ...(inputsLocked ? s.codexComposerAddImageBtnDisabled : {}),
            }}
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
              addImageFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <span style={s.codexComposerFocusHint}>Ctrl+L</span>
          <button
            type="button"
            disabled={!canSend}
            style={{
              ...s.codexComposerSendBtn,
              ...(!canSend ? s.codexComposerSendBtnDisabled : {}),
            }}
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
}
