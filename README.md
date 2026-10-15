# Speedy

Speedy is a fast, standalone Mac app for running Claude Code agents in parallel across project folders. Each thread gets a chat panel modeled on the Claude Code VS Code extension and a real terminal docked below it. It drives your installed `claude` CLI under your own login. Your settings, MCP servers, hooks, and session history carry over, and Speedy never touches your credentials.

The plan is in [docs/plans/2026-10-14-2022-feat-speedy-claude-desktop-plan.md](docs/plans/2026-10-14-2022-feat-speedy-claude-desktop-plan.md).

## Build and install

Prerequisites: Rust (rustup), Bun, Xcode Command Line Tools, and the `claude` CLI, logged in.

```sh
bun install
bun run tauri build          # → src-tauri/target/release/bundle/macos/Speedy.app (ad-hoc signed)
cp -R src-tauri/target/release/bundle/macos/Speedy.app /Applications/
open /Applications/Speedy.app
```

To open folders from a terminal like VS Code's `code .`, choose **Speedy > Install 'speedy' Command in PATH…** once. Then `speedy .` (or `speedy ~/a ~/b`) adds each folder as a project, or selects it if it's already open. The command goes through LaunchServices, so it needs the bundled app, not `tauri dev`.

For development, run `bun run tauri dev`. Notifications only work from the bundled `.app`. Under `tauri dev`, the log reports them as unavailable.

## Checks

| Gate | Command |
|---|---|
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` |
| UI tests | `bun run test` |
| Typecheck | `bun run typecheck` |
| Protocol drift (real CLI; denies every tool, uses haiku) | `cargo test --manifest-path src-tauri/Cargo.toml --test claude_actor_test -- --ignored` |
| Theme regeneration | `bun scripts/gen-vscode-theme.ts` |

Run the protocol drift test whenever the setup screen warns that your CLI version differs from the last version it passed against (2.1.301; fixtures recorded against 2.1.296).

## Layout

- `src-tauri/src/`: the Rust core.
  - `env.rs`: login-shell env, CLI discovery, extension settings
  - `claude/`: per-thread CLI actor, stream-json protocol, permission diffs
  - `pty/`: per-thread shell
  - `state/`: app state and the CLI session index
  - `files.rs`: @-mention search
  - `attention.rs`: notifications and Dock badge
  - `menu.rs`: native menu
  - `cli.rs`: `speedy .` command and folders opened from Finder or the Dock
- `src/`: the React webview.
  - `app/`, `sidebar/`: shell, layout, shortcuts
  - `theme/`: generated `--vscode-*` tokens
  - `store/`: thread store, reducer, runtime bridge
  - `chat/`: transcript
  - `composer/`
  - `permissions/`
  - `history/`
  - `terminal/`

## Manual test checklist

Tauri's WebDriver doesn't support macOS, so these checks are manual. Start with the U1 gates (`spike/RESULTS.md`). If one of them fails, the plan says to stop and re-plan.

**U1 gates**
- [ ] Terminal: `cat` a 50 MB file and check the UI stays responsive. Keystroke echo should feel instant (about 30 ms or less).
- [ ] Terminal: vim (including mouse scrolling), htop, less, `git log` paging, and the `claude` TUI all work. Option+B and Option+F jump by word.
- [ ] Shortcuts: Cmd+K (clear), Cmd+F (find), Cmd+C and Cmd+V reach the terminal. Cmd+N, Cmd+1 and Cmd+J still fire while the terminal has focus.
- [ ] Notifications: the first launch of the bundled app asks for permission. A permission request in a hidden thread posts a banner, and clicking it opens that thread.

**Setup**
- [ ] Launching from the Dock or Finder finds the nvm-installed `claude`. After `claude auth logout`, the setup screen asks you to log in.

**Chat parity** (compare side by side with the VS Code panel, in light and dark)
- [ ] Colors, fonts, spacing, codicons: empty state, sidebar, transcript, tool cards, thinking rows, todo list, spinner verbs, code blocks.
- [ ] Composer: Enter and Shift+Enter, `/` menu, `@` file search, pasting an image, queued messages, Esc to interrupt, Shift+Tab mode cycling.
- [ ] Model picker, permission modes, the Effort row, and the context ring (it appears above 50% usage).
- [ ] Permission cards: Edit, Write to a new file, Bash, plan-mode exit, AskUserQuestion. Always-allow names where the rule is saved, and the rule lands in that settings file.
- [ ] Stale diff: while a diff card is open, edit the same file from another thread, then accept. The card refreshes and asks again.
- [ ] History: sessions from VS Code and the CLI are listed. Resuming works in both directions without losing turns. Rename survives, and offline renames show up in `claude --resume`. The live-elsewhere warning appears for a session active in the last 60 s.
- [ ] Rewind: "Fork conversation and rewind code" restores the files and continues in a new thread.

**`speedy .`**
- [ ] The menu item installs `/usr/local/bin/speedy`, asking for a password if needed. `speedy .` works with Speedy quit (cold launch) and running, and brings the window forward.

**Parallel work**
- [ ] Three agents run in hidden threads. Every permission request and completion is surfaced through the sidebar status, the unread glyph, the Dock badge, and a notification.
- [ ] Cmd+W on a working thread asks first. On an idle thread it archives, and the thread can be restored from Archived.
- [ ] Quitting with a dev server running in a terminal kills it. Quitting with a pending permission denies it, and the agent reports the denial after a resume.

**Performance**
- [ ] Fill in the 5-thread comparison against VS Code in [docs/perf.md](docs/perf.md).

## Known gaps and decisions

- Queued messages appear above the composer, as the plan asked. The extension shows them at the end of the transcript.
- Effort can only be changed during a live session (`apply_flag_settings`). It isn't persisted per thread.
- Images can be pasted into the composer, but dragging an image file onto it isn't supported, because Tauri's native drop handling delivers only file paths.
- "Fork conversation" opens the fork in a new thread, because a thread is never rebound to another session. The extension reuses the same tab by default.
- If you relaunch before sending the first message in a forked thread, that thread opens blank. The original thread is unaffected.
- The `--vscode-*` theme tokens are generated from VS Code's built-in theme JSON and color registry, not captured from a running VS Code webview (see `scripts/gen-vscode-theme.ts`).
