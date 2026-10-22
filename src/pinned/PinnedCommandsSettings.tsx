// The Pinned Commands tab of Settings: a table of the commands in every thread's Commands menu,
// in menu order (drag a row to reorder), each switchable on and off, with Add/Edit
// in a dialog of its own over Settings.
import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { createPortal } from "react-dom";
import type { PinnedCommand, PinnedCommandKind } from "../ipc/types";
import { hostLabel, newId, useAppStore } from "../store/appStore";
import { pinnedActionLabel, pinnedIcon } from "./run";
import { beginDragReorder } from "../sidebar/dragReorder";
import "./pinned.css";

const save = (pinnedCommands: PinnedCommand[]) => useAppStore.getState().updateSettings({ pinnedCommands });

/** Asks first, then deletes; resolves whether it did. */
async function confirmDelete(cmd: PinnedCommand): Promise<boolean> {
  const ok = await ask(`"${cmd.name}" will be removed from every thread's Commands menu.`, {
    title: "Delete command?",
    kind: "warning",
    okLabel: "Delete",
    cancelLabel: "Cancel",
  });
  // Read after the prompt: the list may have changed while it was open.
  if (ok) save(useAppStore.getState().pinnedCommands.filter((c) => c.id !== cmd.id));
  return ok;
}

const hostsLabel = (hosts: string[]) => (hosts.length === 0 ? "All hosts" : hosts.map(hostLabel).join(", "));

export function PinnedCommandsSettings() {
  const commands = useAppStore((s) => s.pinnedCommands);
  /** The command being edited; "new" while adding. */
  const [editing, setEditing] = useState<PinnedCommand | "new" | null>(null);

  const upsert = (cmd: PinnedCommand) => {
    save(commands.some((c) => c.id === cmd.id) ? commands.map((c) => (c.id === cmd.id ? cmd : c)) : [...commands, cmd]);
    setEditing(null);
  };

  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  /** `toIndex` counts the other rows, as `beginDragReorder` reports it. */
  const move = (id: string, toIndex: number) => {
    const moved = commands.find((c) => c.id === id);
    if (!moved) return;
    const next = commands.filter((c) => c.id !== id);
    next.splice(toIndex, 0, moved);
    if (next.some((c, i) => c !== commands[i])) save(next);
  };
  const setEnabled = (id: string, enabled: boolean) => save(commands.map((c) => (c.id === id ? { ...c, enabled } : c)));

  return (
    <div className="settings-section">
      <div className="pinned-settings-head">
        <p className="settings-description">In the composer's Commands menu. They run in the thread's folder, or its worktree. Drag to reorder.</p>
        <button type="button" className="secondary-button pinned-add" onClick={() => setEditing("new")}>
          <span className="codicon codicon-add" aria-hidden />
          Add Command
        </button>
      </div>
      <div className="pinned-table-wrap">
        <table className="pinned-table" aria-label="Pinned commands">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">Order</span>
              </th>
              <th scope="col">
                <span className="visually-hidden">Enabled</span>
              </th>
              <th scope="col">Name</th>
              <th scope="col">Action</th>
              <th scope="col">Command</th>
              <th scope="col">Hosts</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody ref={tbodyRef}>
            {commands.length === 0 && (
              <tr>
                <td colSpan={7} className="pinned-empty">
                  No pinned commands yet.
                </td>
              </tr>
            )}
            {commands.map((c) => (
              <tr
                key={c.id}
                data-drag-id={c.id}
                data-disabled={!c.enabled || undefined}
                onDoubleClick={() => setEditing(c)}
                onPointerDown={(event) =>
                  beginDragReorder({
                    id: c.id,
                    event,
                    items: () => [...(tbodyRef.current?.querySelectorAll<HTMLElement>("tr[data-drag-id]") ?? [])],
                    onDrop: move,
                  })
                }
              >
                <td className="pinned-cell-grip" title="Drag to reorder">
                  <span className="codicon codicon-gripper" aria-hidden />
                </td>
                <td className="pinned-cell-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    className="pinned-switch"
                    aria-label={`Show ${c.name} in the Commands menu`}
                    title={c.enabled ? "Shown in the Commands menu" : "Hidden from the Commands menu"}
                    checked={c.enabled}
                    onChange={(e) => setEnabled(c.id, e.target.checked)}
                  />
                </td>
                <td className="pinned-cell-name">{c.name}</td>
                <td>
                  <span className="pinned-kind" data-kind={c.kind}>
                    <i className={`codicon codicon-${pinnedIcon(c)}`} aria-hidden="true" />
                    {pinnedActionLabel(c)}
                  </span>
                </td>
                <td className="pinned-cell-command" title={c.command}>
                  <code>{c.command}</code>
                </td>
                <td className="pinned-cell-hosts" title={hostsLabel(c.hosts)}>
                  {hostsLabel(c.hosts)}
                </td>
                <td className="pinned-cell-actions">
                  <button type="button" className="icon-button" aria-label={`Edit ${c.name}`} title="Edit" onClick={() => setEditing(c)}>
                    <span className="codicon codicon-edit" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${c.name}`}
                    title="Delete"
                    onClick={() => void confirmDelete(c)}
                  >
                    <span className="codicon codicon-trash" aria-hidden />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <PinnedCommandEditor
          initial={editing === "new" ? null : editing}
          onSave={upsert}
          onDelete={async (cmd) => {
            if (await confirmDelete(cmd)) setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

const KIND_LABEL: Record<PinnedCommandKind, string> = { prompt: "Claude Prompt", terminal: "Terminal Command" };

function PinnedCommandEditor({
  initial,
  onSave,
  onDelete,
  onClose,
}: {
  initial: PinnedCommand | null;
  onSave: (cmd: PinnedCommand) => void;
  onDelete: (cmd: PinnedCommand) => void;
  onClose: () => void;
}) {
  const hosts = useAppStore((s) => s.hosts);
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<PinnedCommandKind>(initial?.kind ?? "prompt");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [autoSubmit, setAutoSubmit] = useState(initial?.autoSubmit ?? true);
  const [allHosts, setAllHosts] = useState((initial?.hosts.length ?? 0) === 0);
  const [picked, setPicked] = useState<string[]>(initial?.hosts ?? []);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => nameRef.current?.focus(), []);

  // Hosts it was pinned to that are gone from this Mac still show, so they can be unpinned.
  const hostKeys = [...hosts.map((h) => h.key), ...picked.filter((k) => !hosts.some((h) => h.key === k))];
  const valid = name.trim() !== "" && command.trim() !== "" && (allHosts || picked.length > 0);

  const submit = () => {
    if (!valid) return;
    onSave({
      id: initial?.id ?? newId(),
      name: name.trim(),
      kind,
      command: command.trim(),
      autoSubmit: kind === "prompt" && autoSubmit,
      hosts: allHosts ? [] : hostKeys.filter((k) => picked.includes(k)),
      enabled: initial?.enabled ?? true,
    });
  };

  const title = initial ? "Edit Command" : "Add Command";

  return createPortal(
    <div className="pinned-editor-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="pinned-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pinned-editor-title"
        onKeyDown={(e) => {
          // Settings stays open: Escape only closes this dialog.
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            submit();
          }
        }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <header className="settings-header">
          <h2 id="pinned-editor-title" className="settings-title">
            {title}
          </h2>
          <button type="button" className="icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <span className="codicon codicon-close" aria-hidden />
          </button>
        </header>

        <div className="pinned-field">
          <label htmlFor="pinned-name">Name</label>
          <input
            id="pinned-name"
            ref={nameRef}
            className="vscode-input"
            value={name}
            placeholder={kind === "prompt" ? "Review" : "Build"}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="pinned-field">
          <span id="pinned-kind">Type</span>
          <span className="settings-segmented" role="radiogroup" aria-labelledby="pinned-kind">
            {(Object.keys(KIND_LABEL) as PinnedCommandKind[]).map((k) => (
              <label key={k} className="settings-segment" data-checked={k === kind || undefined}>
                <input type="radio" name="pinned-kind" value={k} checked={k === kind} onChange={() => setKind(k)} />
                {KIND_LABEL[k]}
              </label>
            ))}
          </span>
        </div>

        <div className="pinned-field">
          <label htmlFor="pinned-command">{kind === "prompt" ? "Prompt" : "Command"}</label>
          <textarea
            id="pinned-command"
            className="vscode-input pinned-command-input"
            rows={kind === "prompt" ? 4 : 2}
            spellCheck={false}
            value={command}
            placeholder={kind === "prompt" ? "Review the uncommitted changes for bugs" : "npm run build\ncd ~/commands && ./alert-slack.sh"}
            onChange={(e) => setCommand(e.target.value)}
          />
          <span className="settings-description">
            {kind === "prompt"
              ? "Sent to the thread's Claude, which works in the thread's folder or worktree."
              : "Runs in a new terminal tab, starting in the thread's folder or worktree."}
          </span>
        </div>

        {kind === "prompt" && (
          <label className="pinned-check">
            <input type="checkbox" checked={autoSubmit} onChange={(e) => setAutoSubmit(e.target.checked)} />
            <span className="settings-label">
              Send immediately
              <span className="settings-description">Otherwise it fills the composer, to edit before sending.</span>
            </span>
          </label>
        )}

        <fieldset className="pinned-field pinned-hosts">
          <legend>Hosts</legend>
          <label className="pinned-check">
            <input type="checkbox" checked={allHosts} onChange={(e) => setAllHosts(e.target.checked)} />
            <span className="settings-label">All hosts</span>
          </label>
          {!allHosts && (
            <div className="pinned-host-list">
              {hostKeys.map((k) => (
                <label key={k} className="pinned-check">
                  <input
                    type="checkbox"
                    checked={picked.includes(k)}
                    onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))}
                  />
                  <span className="settings-label">{hostLabel(k)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <footer className="pinned-editor-footer">
          {initial && (
            <button type="button" className="secondary-button pinned-editor-delete" onClick={() => onDelete(initial)}>
              <span className="codicon codicon-trash" aria-hidden />
              Delete
            </button>
          )}
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={!valid}>
            {initial ? "Save" : "Add"}
          </button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
