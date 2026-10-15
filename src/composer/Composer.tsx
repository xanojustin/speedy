// U9: the composer for one thread (R9, R10): auto-growing input with the extension's send keys,
// `/` command menu, @-mention file search, image paste, the queue, Esc-to-interrupt, and the
// footer's model / mode / effort / context-usage controls.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { isLiveStatus, type FileHit, type PermissionMode } from "../ipc/types";
import { findThread, useAppStore } from "../store/appStore";
import { controlRequest, interruptThread, removeQueued, sendUserMessage } from "../store/runtime";
import { getRuntime, useThreadRuntime, useThreadStore } from "../store/threadStore";
import { FOCUS_COMPOSER_EVENT, type FocusComposerDetail } from "./focusEvent";
import { MentionMenu, useFileMentions } from "./Mentions";
import {
  ContextUsage,
  EFFORT_LABEL,
  prettyModelId,
  ModeMenu,
  ModelPicker,
  availableModes,
  findModel,
  modelOptions,
  nextMode,
  type EffortControl,
  type ModelOption,
} from "./Pickers";
import { QueueList } from "./QueueList";
import { useSessionControls, type EffortLevel } from "./sessionControls";
import { useComposerSettings } from "./settings";
import { SlashMenu, filterSlash, slashCommands, type SlashCommand } from "./SlashMenu";
import "./composer.css";

/** Image types the Messages API accepts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INPUT_HEIGHT = 200;

interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  /** base64 without the data-URL prefix */
  data: string;
  dataUrl: string;
}

function readImage(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = String(reader.result);
      resolve({
        id: crypto.randomUUID(),
        name: file.name || "image",
        mediaType: file.type,
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        dataUrl,
      });
    };
    reader.readAsDataURL(file);
  });
}

function notice(threadId: string, text: string) {
  useThreadStore.getState().dispatch(threadId, { kind: "local_notice", variant: "warning", text });
}

export function Composer({ threadId }: { threadId: string }) {
  const rt = useThreadRuntime(threadId);
  const thread = useAppStore((s) => findThread(s, threadId)?.thread ?? null);
  const root = useAppStore((s) => findThread(s, threadId)?.project.path ?? null);
  const settings = useComposerSettings();
  const acked = useSessionControls((s) => s.modes[threadId]);
  const effort = useSessionControls((s) => s.effort[threadId] ?? null);

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<Attachment[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  /** The input text at which the user dismissed the open menu with Esc. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const busy = rt.status === "working" || rt.status === "awaiting_user";
  const live = rt.init != null && isLiveStatus(rt.status);

  // ---------- menus ----------
  const before = text.slice(0, caret);
  const slashMatch = /^\/(\S*)$/.exec(before);
  const mentionMatch = slashMatch ? null : /(?:^|\s)@(\S*)$/.exec(before);
  const dismissed = dismissedAt === text;
  const slashQuery = slashMatch && !dismissed ? slashMatch[1] : null;
  const mentionQuery = mentionMatch && !dismissed ? mentionMatch[1] : null;

  const commands = slashCommands(rt.init, rt.systemInit);
  const slashItems: SlashCommand[] = slashQuery !== null && commands ? filterSlash(commands, slashQuery) : [];
  const hits = useFileMentions(root, mentionQuery, settings?.respectGitIgnore ?? true);
  const menu = slashQuery !== null ? "slash" : mentionQuery !== null ? "mention" : null;
  const menuCount = menu === "slash" ? slashItems.length : menu === "mention" ? hits.length : 0;
  const menuKey = `${menu}:${slashQuery ?? mentionQuery ?? ""}`;

  useEffect(() => setActiveIndex(0), [menuKey]);

  // ---------- input plumbing ----------
  const applyText = (next: string, nextCaret: number) => {
    pendingCaret.current = nextCaret;
    setText(next);
    setCaret(nextCaret);
  };

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  const focusInput = useCallback(() => inputRef.current?.focus(), []);

  useEffect(() => {
    focusInput();
    const onFocus = (e: Event) => {
      if ((e as CustomEvent<Partial<FocusComposerDetail>>).detail?.threadId === threadId) focusInput();
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
  }, [threadId, focusInput]);

  const selectSlash = (c: SlashCommand) => {
    const head = `/${c.name} `;
    applyText(head + text.slice(caret), head.length);
  };

  const selectMention = (h: FileHit) => {
    if (!mentionMatch) return;
    const start = caret - mentionMatch[1].length - 1;
    const insert = `@${h.path}${h.isDir ? "/" : " "}`;
    applyText(text.slice(0, start) + insert + text.slice(caret), start + insert.length);
  };

  // ---------- sending ----------
  const canSend = text.trim() !== "" || images.length > 0;

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && images.length === 0) return;
    const content: unknown[] = [
      ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
      ...(trimmed ? [{ type: "text", text: trimmed }] : []),
    ];
    applyText("", 0);
    setImages([]);
    void sendUserMessage(threadId, content);
  };

  const interrupt = () => {
    interruptThread(threadId).catch((err: unknown) => notice(threadId, `Couldn't interrupt: ${String(err)}`));
  };

  // ---------- permission mode ----------
  const modes = availableModes(settings?.allowDangerouslySkipPermissions ?? false);
  const cliMode = rt.permissionMode;
  const liveMode = acked && acked.basis === cliMode ? acked.mode : cliMode;
  const mode: PermissionMode = (live ? (liveMode ?? thread?.permissionMode) : (thread?.permissionMode ?? settings?.initialPermissionMode)) ?? "default";

  // New threads start in `claudeCode.initialPermissionMode`; persisting it makes ensureStarted pass it.
  useEffect(() => {
    if (!settings || !thread) return;
    const initial = settings.initialPermissionMode;
    if (!initial || initial === "default") return;
    if (initial === "bypassPermissions" && !settings.allowDangerouslySkipPermissions) return;
    if (thread.permissionMode == null && !thread.sessionId && getRuntime(threadId).status === "not_started") {
      useAppStore.getState().updateThread(threadId, { permissionMode: initial });
    }
    // Only when settings arrive or the thread changes; not on every thread edit.
  }, [settings, threadId]);

  const setMode = async (m: PermissionMode) => {
    if (!live) {
      useAppStore.getState().updateThread(threadId, { permissionMode: m });
      return;
    }
    try {
      await controlRequest(threadId, { subtype: "set_permission_mode", mode: m });
    } catch (err) {
      notice(threadId, `Couldn't switch to ${m}: ${String(err)}`);
      return;
    }
    useSessionControls.getState().setAckedMode(threadId, { mode: m, basis: getRuntime(threadId).permissionMode });
    useAppStore.getState().updateThread(threadId, { permissionMode: m });
  };

  // ---------- model + effort ----------
  const options = modelOptions(rt.init);
  const systemModel = typeof rt.systemInit?.model === "string" ? rt.systemInit.model : null;
  const chosen = thread?.model ?? settings?.selectedModel ?? null;
  const current: ModelOption | undefined = findModel(options, chosen) ?? (chosen ? undefined : findModel(options, systemModel));
  const fallbackModel = chosen ?? systemModel;
  const modelLabel = current?.displayName ?? (fallbackModel ? prettyModelId(fallbackModel) : "Model");

  const selectModel = async (o: ModelOption) => {
    if (live) {
      try {
        await controlRequest(threadId, { subtype: "set_model", model: o.value });
      } catch (err) {
        notice(threadId, `Couldn't switch model: ${String(err)}`);
        return;
      }
    }
    useAppStore.getState().updateThread(threadId, { model: o.value });
  };

  const setEffort = async (level: EffortLevel) => {
    try {
      await controlRequest(threadId, { subtype: "apply_flag_settings", settings: { effortLevel: level } });
    } catch (err) {
      notice(threadId, `Couldn't set effort: ${String(err)}`);
      return;
    }
    useSessionControls.getState().setEffort(threadId, level);
  };

  // Until the user picks one, effort is the global Claude default the CLI applied at spawn.
  const globalEffort = settings?.defaultEffort && settings.defaultEffort in EFFORT_LABEL ? (settings.defaultEffort as EffortLevel) : null;
  const shownEffort = effort ?? globalEffort;
  const effortControl: EffortControl | null =
    live && current?.supportsEffort
      ? { level: shownEffort, levels: current.supportedEffortLevels ?? ["low", "medium", "high"], onSet: (l) => void setEffort(l) }
      : null;
  const effortLabel = (current ? current.supportsEffort : true) && shownEffort ? EFFORT_LABEL[shownEffort] : null;

  // ---------- context usage: refresh after every result ----------
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!rt.lastResult || !liveRef.current) return;
    controlRequest(threadId, { subtype: "get_context_usage" }).catch(() => {
      // Older CLIs lack get_context_usage; the indicator just stays hidden.
    });
  }, [rt.lastResult, threadId]);

  // ---------- keys ----------
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (menu && menuCount > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => (i + d + menuCount) % menuCount);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        const i = Math.min(activeIndex, menuCount - 1);
        if (menu === "slash") selectSlash(slashItems[i]);
        else selectMention(hits[i]);
        return;
      }
    }
    if (menu && e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(text);
      return;
    }
    if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      void setMode(nextMode(mode, modes));
      return;
    }
    if (e.key === "Escape") {
      if (busy) {
        e.preventDefault();
        interrupt();
      }
      return;
    }
    // Ctrl+J inserts a newline, as in the extension.
    if (e.key.toLowerCase() === "j" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const el = e.currentTarget;
      const at = el.selectionStart;
      applyText(text.slice(0, at) + "\n" + text.slice(el.selectionEnd), at + 1);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const mod = e.metaKey || e.ctrlKey;
      if (settings?.useCtrlEnterToSend ? mod : true) {
        e.preventDefault();
        submit();
      }
      // Otherwise the textarea inserts the newline.
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter((i) => i.kind === "file" && IMAGE_TYPES.has(i.type))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      readImage(f).then(
        (att) => setImages((prev) => [...prev, att]),
        (err: unknown) => notice(threadId, `Couldn't attach image: ${String(err)}`),
      );
    }
  };

  const showStop = busy && !canSend;

  return (
    <div className="composer" data-thread={threadId}>
      <QueueList queue={rt.queue} onRemove={(id) => removeQueued(threadId, id)} />
      <div className="composer-input-wrap">
        {menu === "slash" && (
          <SlashMenu items={slashItems} started={commands !== null} activeIndex={activeIndex} onSelect={selectSlash} onHover={setActiveIndex} />
        )}
        {menu === "mention" && <MentionMenu hits={hits} activeIndex={activeIndex} onSelect={selectMention} onHover={setActiveIndex} />}
        <div className="composer-box" data-permission-mode={mode}>
          {images.length > 0 && (
            <div className="composer-attachments">
              {images.map((img) => (
                <div key={img.id} className="composer-thumb" title={img.name}>
                  <img src={img.dataUrl} alt={img.name} />
                  <button
                    type="button"
                    className="composer-thumb-remove"
                    aria-label={`Remove ${img.name}`}
                    onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
                  >
                    <i className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="composer-input"
            aria-label="Message input"
            rows={1}
            value={text}
            placeholder={busy ? "Queue another message…" : "Ask Claude to edit…"}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <div className="composer-footer">
            <button
              type="button"
              className="composer-icon-button"
              title="Show command menu (/)"
              aria-label="Show command menu"
              onClick={() => {
                if (!text) applyText("/", 1);
                focusInput();
              }}
            >
              <span className="composer-slash-glyph" aria-hidden="true">/</span>
            </button>
            <ContextUsage usage={rt.contextUsage} onCompact={() => void sendUserMessage(threadId, [{ type: "text", text: "/compact" }])} />
            <ModelPicker label={modelLabel} effortLabel={effortLabel} options={options} current={current} onSelect={(o) => void selectModel(o)} />
            <div className="composer-spacer" />
            <ModeMenu mode={mode} modes={modes} onSelect={(m) => void setMode(m)} effort={effortControl} />
            <button
              type="button"
              className="send-button"
              data-permission-mode={mode}
              aria-label={showStop ? "Stop" : "Send message"}
              title={showStop ? "Stop" : "Send message"}
              disabled={!showStop && !canSend}
              onClick={showStop ? interrupt : submit}
            >
              <i className={`codicon codicon-${showStop ? "debug-stop" : "arrow-up"}`} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
