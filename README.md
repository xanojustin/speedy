<p align="center">
  <img src="assets/icon.png" alt="Speedy icon" width="128" height="128">
</p>

# Speedy

Speedy is a fast, native Mac app for running several Claude Code agents at once, across as many project folders as you like. Each thread gets a chat panel that looks and behaves like the Claude Code VS Code extension, with real terminals docked below it.

Speedy drives the `claude` CLI you already have installed, under your own login. Your settings, MCP servers, hooks, skills, and session history carry over unchanged, and Speedy never reads or stores your credentials.

## Why

The VS Code extension is a good place to talk to Claude, but running five agents in parallel there means five editor tabs, five terminals, and a lot of window juggling. Speedy keeps each conversation in its own thread, tells you when a hidden one needs you, and launches in well under a second.

## Features

- **Parallel threads.** Group projects in the sidebar and run a thread per task. Threads that finish or ask for permission while hidden are flagged in the sidebar and on the Dock badge, and post a notification.
- **Familiar chat.** Same colors, fonts, tool cards, thinking rows, todo list, and permission cards as the VS Code extension, in light and dark.
- **Composer.** `/` command menu (plugin commands match by short name, so `/ce-plan` finds `/compound-engineering:ce-plan`), `@` file mentions, pasted images, queued messages, Esc to interrupt, Shift+Tab to cycle permission modes, plus model and effort pickers. The footer shows how much of the context window is used; click it for a breakdown and to compact.
- **Permissions.** Inline cards for edits (with diffs), Bash, plan approval, and questions. "Always allow" names the settings file the rule is saved to.
- **Terminals.** A real PTY per thread with multiple tabs, WebGL rendering, search, and links. Select output and press Cmd+L to attach it to your next message. Shells are killed when you quit.
- **History.** Browse and resume sessions started in VS Code or the CLI, rename them, and fork a conversation with its code rewound to an earlier turn.
- **Worktrees.** Optionally start a thread on its own branch in a separate git worktree, so parallel agents don't step on each other's files.
- **File explorer** and a `speedy .` shell command, like VS Code's `code .`. File references in Claude's replies (`src/app.ts:42`) open in the explorer at that line.

## Requirements

- macOS 13 or later
- The [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code), installed and logged in (`claude` works in your terminal)
- To build: [Rust](https://rustup.rs), [Bun](https://bun.sh), and the Xcode Command Line Tools

## Install

There are no prebuilt releases yet, so build it from source:

```sh
git clone https://github.com/xanojustin/speedy.git
cd speedy
./scripts/reinstall.sh
```

The script installs dependencies, builds `Speedy.app` (ad-hoc signed), quits any running copy, installs it to `/Applications`, and opens it. Run it again to update after pulling. Pass `--no-open` to skip launching.

To do it by hand:

```sh
bun install
bun run tauri build
cp -R src-tauri/target/release/bundle/macos/Speedy.app /Applications/
```

On first launch Speedy finds `claude` through your login shell, so CLIs installed with nvm, Homebrew, or similar work even when the app is opened from the Dock. If the CLI is missing or logged out, the setup screen tells you what to do.

### The `speedy` command

Choose **Speedy > Install 'speedy' Command in PATH…** once. After that, `speedy .` (or `speedy ~/a ~/b`) adds each folder as a project, or selects it if it's already open. It works whether or not Speedy is running.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Cmd+N | New thread |
| Cmd+W | Close thread (archives it; asks first if it's working) |
| Cmd+O | Add project folder |
| Cmd+1 … Cmd+9 | Switch to thread 1–9 |
| Cmd+L | Focus chat (in the terminal with a selection: attach it to the chat) |
| Cmd+J | Toggle terminal |
| Cmd+Shift+J | Maximize terminal |
| Ctrl+Shift+` | New terminal tab |
| Cmd+Shift+E | Toggle file explorer |
| Cmd+, | Settings |

In the composer: Enter sends, Shift+Enter (or Ctrl+J) adds a newline, Esc interrupts, and Shift+Tab cycles permission modes.

## Worktrees

Before a thread's first message, the composer footer has a **Worktree** toggle. When it's on, the first message puts the thread on a new `speedy/<thread-id>` branch, created from the project's `HEAD`, in its own worktree under `~/Library/Application Support/Speedy/worktrees/`. Rename the branch whenever you like with `git branch -m`.

A few things to know:

- The choice is locked after the first message. Forks keep their thread's worktree.
- Speedy never deletes worktrees (archived threads can be restored), so clean them up with `git worktree remove`.
- Gitignored files such as `.env` and `node_modules` aren't copied into a new worktree.
- Sessions from worktree threads don't show up in the project's history list, because the CLI files them under the worktree's path.

## Hosts

Threads, terminals, files and git run on a host: This Mac, or another Mac you reach over SSH. Each host runs `speedy-agent`, which owns that host's threads and shells, so they keep running while no Speedy window is connected. Close the laptop while a thread works on your Mac mini, and when you open it again the transcript, any pending permission prompt, and recent terminal output are all there.

- **This Mac** is always a host. Speedy installs its agent as a LaunchAgent on first launch. Quitting Speedy leaves it and its threads running; **Speedy > Stop This Mac's Agent…** stops them.
- **Add a host** in **Settings > Hosts**: pick an entry from `~/.ssh/config`. Speedy connects with your own `ssh`, so keys, agents, ProxyJump and 1Password work as they do in a terminal. The first connect uploads the agent to `~/.speedy/agent` on that Mac and starts it. Passphrase and 2FA prompts appear in Speedy.
- **Projects belong to one host.** With more than one host, the sidebar shows a section per host and says how each is doing. Adding a project on a remote host browses that host's folders, and Open in VS Code opens a VS Code remote window there.
- **Logging in.** The agent runs in the host's login session so `claude` can use its Keychain login. If the host's agent can't reach the Keychain (for example, nobody is logged in at its screen), run `claude setup-token` on that host and paste the token into **Settings > Hosts**.
- **Updates.** A newer Speedy updates each host's agent, but only once nothing there is working; until then the older agent keeps going.
- Hosts are Macs only for now. Keep an always-on host from sleeping in **System Settings > Energy**; the agent only holds it awake while a thread works.

## Known limitations

- Effort can only be changed during a live session, and isn't saved per thread.
- You can paste images into the composer, but not drag image files onto it.
- "Fork conversation" always opens the fork in a new thread.
- If you relaunch before sending the first message in a forked thread, that thread opens blank. The original thread is unaffected.
- Notifications only work from the bundled app, not under `tauri dev`.

## Development

```sh
bun install
bun run tauri dev
```

`tauri dev` and `tauri build` first run `scripts/build-agent.sh`, which builds `speedy-agent` and puts it where Tauri bundles it (universal when both Rust targets are installed). A plain `cargo build` uses a stub agent that refuses to run.

| Check | Command |
|---|---|
| UI tests | `bun run test` |
| Typecheck | `bun run typecheck` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml --workspace` |
| Rust lint | `cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings` |
| Protocol drift (real CLI, denies every tool, uses Haiku) | `cargo test --manifest-path src-tauri/Cargo.toml -p speedy-core --test claude_actor_test -- --ignored` |
| Regenerate theme tokens | `bun scripts/gen-vscode-theme.ts` |

Speedy talks to the CLI over its stream-json protocol, which can change between CLI releases. When the setup screen warns that your CLI version differs from the last one tested, run the protocol drift test.

### Layout

- `src-tauri/crates/speedy-core/`: everything that runs on a host, with no Tauri dependency
  - `claude/`: one CLI process per thread, the stream-json protocol, and permission diffs
  - `host/`: the host's projects and threads, their queue and replay log, and migration from the old `state.json`
  - `proto/`: the agent wire protocol
  - `pty/`: terminal shells
  - `state/`: state files and the CLI session index
  - `env.rs`: login-shell environment and CLI discovery
  - `files.rs`, `explorer.rs`, `worktree.rs`: `@` mention search, the explorer and git, worktrees
- `src-tauri/crates/speedy-agent/`: the per-host daemon: socket server, launchd install, and sleep prevention
- `src-tauri/src/`: the app
  - `hosts/`: connections to hosts, SSH, installing and updating agents, and SSH prompts
  - `attention.rs`: notifications and the Dock badge
  - `menu.rs`: native menu and shortcuts
  - `cli.rs`: the `speedy` command and folders opened from Finder or the Dock
- `src/`: the React webview
  - `app/`, `sidebar/`, `settings/`: shell, layout, and shortcuts
  - `chat/`, `composer/`, `permissions/`, `history/`, `terminal/`, `explorer/`
  - `store/`: thread store, reducer, and runtime bridge
  - `theme/`: `--vscode-*` tokens generated from VS Code's built-in themes

Performance notes are in [docs/perf.md](docs/perf.md), and the original design plan is in [docs/plans/](docs/plans/).

Speedy is an independent project and isn't affiliated with or endorsed by Anthropic.
