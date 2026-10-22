// U9: the composer for one thread (R9, R10): auto-growing input with the extension's send keys,
// `/` command menu, @-mention file search, image paste, the queue, Esc-to-interrupt, and the
// footer's model / mode / effort / context-usage controls.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { isLiveStatus, type FileHit, type PermissionMode } from "../ipc/types";
import { useWorktreeChoosable } from "../chat/git";
import "../hosts/hosts.css";
import { findThread, hostLabel, hostStateLabel, threadCwd, useAppStore } from "../store/appStore";
import { controlRequest, interruptThread, removeQueued, sendUserMessage } from "../store/runtime";
import { getRuntime, useThreadRuntime, useThreadStore } from "../store/threadStore";
import { EMPTY_COMPOSER, useDrafts, type Attachment, type ComposerDraft } from "../store/drafts";
import {
  ADD_TO_COMPOSER_EVENT,
  FOCUS_COMPOSER_EVENT,
  PREFILL_COMPOSER_EVENT,
  type AddToComposerDetail,
  type FocusComposerDetail,
  type PrefillComposerDetail,
} from "./focusEvent";
import { MentionMenu, useFileMentions } from "./Mentions";
import { PinnedMenu } from "../pinned/PinnedMenu";
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
import { makeSnippet, snippetPrompt, type Snippet } from "./snippets";
import { SlashMenu, cachedCommands, expandSlash, filterSlash, rememberCommands, slashCommands, type SlashCommand } from "./SlashMenu";
import "./composer.css";

/** Image types the Messages API accepts. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INPUT_HEIGHT = 200;

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
  // While the thread's host is away the transcript stays readable, but nothing can be sent.
  const host = useAppStore((s) => {
    const key = findThread(s, threadId)?.project.hostKey;
    return key ? s.hosts.find((h) => h.key === key) : undefined;
  });
  const hostAway = !!host && host.state.state !== "connected";
  const projectPath = useAppStore((s) => findThread(s, threadId)?.project.path ?? null);
  const hostKey = useAppStore((s) => findThread(s, threadId)?.project.hostKey ?? null);
  const root = useAppStore((s) => {
    const found = findThread(s, threadId);
    return found ? threadCwd(found.project, found.thread) : null;
  });
  const worktreeChoosable = useWorktreeChoosable(threadId);
  const settings = useComposerSettings();
  const acked = useSessionControls((s) => s.modes[threadId]);
  const effort = useSessionControls((s) => s.effort[threadId] ?? null);

  // The unsent message is kept per thread, so switching threads (which remounts this) keeps it.
  const { text, images, snippets } = useDrafts((s) => s.composer[threadId] ?? EMPTY_COMPOSER);
  const updateDraft = useCallback((update: (prev: ComposerDraft) => Partial<ComposerDraft>) => useDrafts.getState().updateComposer(threadId, update), [threadId]);
  const setText = (next: string) => updateDraft(() => ({ text: next }));
  const setImages = (fn: (prev: Attachment[]) => Attachment[]) => updateDraft((d) => ({ images: fn(d.images) }));
  const setSnippets = (fn: (prev: Snippet[]) => Snippet[]) => updateDraft((d) => ({ snippets: fn(d.snippets) }));
  const [caret, setCaret] = useState(text.length);
  const [activeIndex, setActiveIndex] = useState(0);
  /** The input text at which the user dismissed the open menu with Esc. */
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // A restored draft opens with the caret at its end.
  const pendingCaret = useRef<number | null>(text ? text.length : null);

  const busy = rt.status === "working" || rt.status === "awaiting_user";
  const live = rt.init != null && isLiveStatus(rt.status);

  // ---------- menus ----------
  const before = text.slice(0, caret);
  const slashMatch = /^\/(\S*)$/.exec(before);
  const mentionMatch = slashMatch ? null : /(?:^|\s)@(\S*)$/.exec(before);
  const dismissed = dismissedAt === text;
  const slashQuery = slashMatch && !dismissed ? slashMatch[1] : null;
  const mentionQuery = mentionMatch && !dismissed ? mentionMatch[1] : null;

  const liveCommands = useMemo(() => slashCommands(rt.init, rt.systemInit), [rt.init, rt.systemInit]);
  useEffect(() => {
    if (liveCommands && projectPath) rememberCommands(projectPath, liveCommands);
  }, [liveCommands, projectPath]);
  // Before the session starts, the last list this project (or any project) reported.
  const commands = useMemo(() => liveCommands ?? (projectPath ? cachedCommands(projectPath) : null), [liveCommands, projectPath]);
  const slashItems: SlashCommand[] = slashQuery !== null && commands ? filterSlash(commands, slashQuery) : [];
  const hits = useFileMentions(hostKey, root, mentionQuery, settings?.respectGitIgnore ?? true);
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
    const onAdd = (e: Event) => {
      const { detail } = e as CustomEvent<AddToComposerDetail>;
      if (detail?.threadId !== threadId) return;
      const s = makeSnippet(detail.text, detail.source);
      if (s) updateDraft((d) => ({ snippets: [...d.snippets, s] }));
    };
    // A pinned prompt goes before, after or in place of what's typed, joined exactly as written
    // (its own spaces and line breaks do the joining), with the caret at the end.
    const onPrefill = (e: Event) => {
      const { detail } = e as CustomEvent<PrefillComposerDetail>;
      if (detail?.threadId !== threadId) return;
      const prev = useDrafts.getState().composer[threadId]?.text ?? "";
      const next = detail.placement === "replace" ? detail.text : detail.placement === "before" ? detail.text + prev : prev + detail.text;
      pendingCaret.current = next.length;
      setCaret(next.length);
      updateDraft(() => ({ text: next }));
      focusInput();
    };
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    window.addEventListener(ADD_TO_COMPOSER_EVENT, onAdd);
    window.addEventListener(PREFILL_COMPOSER_EVENT, onPrefill);
    return () => {
      window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
      window.removeEventListener(ADD_TO_COMPOSER_EVENT, onAdd);
      window.removeEventListener(PREFILL_COMPOSER_EVENT, onPrefill);
    };
  }, [threadId, focusInput, updateDraft]);

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
  const canSend = !hostAway && (text.trim() !== "" || images.length > 0 || snippets.length > 0);

  const submit = () => {
    if (hostAway) return;
    const trimmed = expandSlash(text.trim(), commands);
    if (!trimmed && images.length === 0 && snippets.length === 0) return;
    // The typed text leads, so a slash command still runs (and takes the output as its arguments).
    const body = [trimmed, ...snippets.map(snippetPrompt)].filter(Boolean).join("\n\n");
    const content: unknown[] = [
      ...images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
      ...(body ? [{ type: "text", text: body }] : []),
    ];
    applyText("", 0);
    updateDraft(() => ({ images: [], snippets: [] }));
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

  // ---------- context usage: refresh once the session starts and after every result ----------
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!rt.init || !liveRef.current) return;
    controlRequest(threadId, { subtype: "get_context_usage" }).catch(() => {
      // Older CLIs lack get_context_usage; the indicator just stays hidden.
    });
  }, [rt.init, rt.lastResult, threadId]);

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
      {hostAway && host && (
        <div className="host-banner" role="status">
          <span className="codicon codicon-plug" aria-hidden />
          {hostLabel(host.key)} is {hostStateLabel(host).toLowerCase()}. Messages and prompts wait until it's back.
        </div>
      )}
      <QueueList queue={rt.queue} onRemove={(id) => removeQueued(threadId, id)} />
      <div className="composer-input-wrap">
        {menu === "slash" && (
          <SlashMenu items={slashItems} started={commands !== null} activeIndex={activeIndex} onSelect={selectSlash} onHover={setActiveIndex} />
        )}
        {menu === "mention" && <MentionMenu hits={hits} activeIndex={activeIndex} onSelect={selectMention} onHover={setActiveIndex} />}
        <div className="composer-box" data-permission-mode={mode}>
          {(images.length > 0 || snippets.length > 0) && (
            <div className="composer-attachments">
              {snippets.map((s) => (
                <div key={s.id} className="composer-snippet" title={s.text.length > 600 ? `${s.text.slice(0, 600)}…` : s.text}>
                  <i className="codicon codicon-terminal" aria-hidden="true" />
                  <span className="composer-snippet-label">
                    {s.source} · {s.lines} {s.lines === 1 ? "line" : "lines"}
                  </span>
                  <button
                    type="button"
                    className="composer-snippet-remove"
                    aria-label={`Remove output from ${s.source}`}
                    onClick={() => setSnippets((prev) => prev.filter((x) => x.id !== s.id))}
                  >
                    <i className="codicon codicon-close" aria-hidden="true" />
                  </button>
                </div>
              ))}
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
            disabled={hostAway}
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
            {worktreeChoosable && thread && (
              <button
                type="button"
                className={`worktree-pill${thread.worktreeRequested ? " on" : ""}`}
                aria-pressed={thread.worktreeRequested ?? false}
                title={
                  thread.worktreeRequested
                    ? "This thread will start on a new branch in its own git worktree"
                    : "Start this thread on a new branch in its own git worktree"
                }
                onClick={() => useAppStore.getState().updateThread(threadId, { worktreeRequested: !thread.worktreeRequested })}
              >
                <i className="codicon codicon-repo-forked" aria-hidden="true" />
                Worktree
              </button>
            )}
            {hostKey && <PinnedMenu threadId={threadId} hostKey={hostKey} hostAway={hostAway} />}
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
