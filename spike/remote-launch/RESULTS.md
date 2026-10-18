# U1 spike results: launching `claude` on the Mac mini

Machine: Mac mini, Apple Silicon, macOS 26.2, reached over Tailscale SSH (key auth). CLI: `claude` 2.1.211 (`/opt/homebrew/bin/claude`, Homebrew). The user is logged in at the console. Run on 2026-10-18.

Probe: `probe.sh <label>` records `launchctl managername`, `claude auth status`, `claude -p … --model haiku`, and whether `~/Documents` and `~/Desktop` can be listed. `detach.pl` runs it in a new session (double fork plus `setsid`, stdio on `/dev/null`) that outlives the SSH session. `dev.brecht.speedy.u1probe.plist` runs it as a LaunchAgent (`ProcessType Interactive`) through `launchctl bootstrap gui/<uid>` over SSH. `resume.sh` tests `--resume` across processes.

## Results

Run after a fresh `/login` on the mini's console:

| Case | `managername` | `auth status` | `claude -p` | Documents / Desktop |
|---|---|---|---|---|
| 1. Plain SSH session | Background | `loggedIn: false` | `OAuth session expired and could not be refreshed` | ok / ok |
| 2. `setsid` process that outlived SSH | Background | `loggedIn: false` | same failure | ok / ok |
| 3. LaunchAgent in `gui/<uid>` | **Aqua** | `loggedIn: true` | **`pong`** | ok / ok |
| 4. Plain SSH with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, read from `~/.speedy/agent/state/claude-token` | Background | | **`pong`** | |

An earlier run, made while the mini's stored login had expired, failed `claude -p` in all three cases. In that run, `auth status` reported logged in from SSH (1) and the LaunchAgent (3), but not from the detached process (2). `auth status` alone is therefore not a reliable sign that `claude` can make requests.

### Resume across processes: works

`resume.sh`, run as a LaunchAgent:
- One `claude -p` process asked the model to remember 7341 and printed `session_id` `9ef40d49-…`.
- A second, separate process ran `claude --resume <id> -p "What number…"` and answered `7341`.

## Decisions for U7 and U11

- **Launch order:** the LaunchAgent in `gui/<uid>` comes first. It is the only context here where `claude` can use the login Keychain. SSH and detached sessions run in the Background session, which can't read the login Keychain or refresh tokens in it. This matches KTD8: the agent bootstraps `dev.brecht.speedy.agent` into `gui/<uid>` with `ProcessType Interactive`.
- **Detached fallback:** a `setsid` daemon can't authenticate from the Keychain, so it needs the `CLAUDE_CODE_OAUTH_TOKEN` token file (the Settings token field). Case 4 shows the token works in a Background session, with no Keychain needed. The token file is now installed on the mini.
- **Full Disk Access:** not needed. The LaunchAgent, and every other case, could list `~/Documents` and `~/Desktop`.
- **Precondition:** `gui/<uid>` exists only while the user is logged in at the console, as on this mini. A host that has rebooted to the login window has no GUI domain, so it falls back to the detached daemon plus a token.
- **Stdin:** `claude -p` reads stdin. Any script that runs it without stdin redirected from `/dev/null` loses the rest of its input; this broke one run of the spike. The agent already gives `claude` its own pipes.
