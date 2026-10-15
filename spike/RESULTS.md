# U1 spike results

Machine: Apple Silicon, macOS 26.6.2. CLI: `claude` 2.1.296 (nvm). Extension inspected: `anthropic.claude-code-2.1.299-darwin-arm64`.

## Protocol gate: PASS

Probe: `spike/protocol-probe.ts` (Bun), KTD4 spawn contract:

```
claude --output-format stream-json --verbose --input-format stream-json \
       --include-partial-messages --permission-prompt-tool stdio
env CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true
```

The probe also passed `--permission-mode default --model haiku` to keep the run cheap.

| Step | Result |
|---|---|
| `initialize` control_request | `control_response` success at about 560 ms. The payload has `commands`, `models`, `agents`, `account`, `current_permission_mode`, `available_output_styles`, `pid`, and more. |
| `system/init` | Arrives after initialize, then again at the start of each turn. Carries `session_id`, `tools`, `slash_commands`, `permissionMode`, `model`, `claude_code_version`. |
| Partial streaming | `stream_event` messages arrive (`message_start`, `content_block_delta` with text, thinking, and input_json deltas, then `message_stop`). |
| `can_use_tool` round trip | The request arrived for `Bash touch ./speedy-probe.txt`. We answered `{behavior:"deny",message}`, and the CLI wrote a `tool_result` with `is_error:true`. The file was not created. |
| `interrupt` | `control_response` success. The turn ends with `result/error_during_execution` (`terminal_reason: "aborted_streaming"`) plus a `[Request interrupted by user]` user message. |

Recorded transcript (account and paths scrubbed): `src-tauri/tests/fixtures/cli-2.1.296-permission-deny-interrupt.ndjson`, as `{dir: "in"|"out", msg}` lines.

### Shapes

- Outgoing user message: `{"type":"user","message":{"role":"user","content":[...]},"parent_tool_use_id":null,"session_id":""}`
- Control request: `{"type":"control_request","request_id":"<id>","request":{"subtype":"..."}}`
- Control response, CLI → us and us → CLI: `{"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{...}}}`. On error: `{"subtype":"error","request_id","error":"<msg>"}`.
- `can_use_tool` request keys: `tool_name, display_name, input, description, permission_suggestions, blocked_path, tool_use_id`. Optional keys: `title`, `decision_reason`, `agent_id`.
- `permission_suggestions` example: `addRules` (destination `localSettings`), `addDirectories` (destination `session`), and `setMode acceptEdits` (destination `session`).
- Allow response: `{behavior:"allow", updatedInput, updatedPermissions?}`. Deny response: `{behavior:"deny", message, interrupt?}`.

### Spawn arguments compared with the extension (SDK in extension.js)

The SDK always passes `--output-format stream-json --verbose --input-format stream-json`. It adds these when they apply:

- thinking flags: `--thinking=adaptive|disabled` or `--max-thinking-tokens N`, plus `--thinking-display`
- `--effort`, `--model`, `--permission-prompt-tool=stdio` (only when canUseTool is set), `--resume`, `--permission-mode`, `--allow-dangerously-skip-permissions`, `--setting-sources`, `--include-partial-messages`, `--mcp-config`, `--resume-session-at`, `--fork-session`, `--session-id`

Parity gap noted for U3: when the user's `claudeCode.allowDangerouslySkipPermissions` setting is on, the extension passes `--allow-dangerously-skip-permissions`. Without that flag the CLI rejects bypass mode, so Speedy passes it under the same condition.

## Terminal, shortcut, and notification gates: built in production code, need manual confirmation

These gates need a human at the keyboard: perceived echo latency, vim, htop, Option-as-Meta, whether WKWebView passes Cmd+K/F/C/V to xterm, and clicking a macOS notification. The agent could not run that interaction. They are built directly in the production units (U4, U7, U12) rather than as throwaway code, and they're listed as the first items in the manual test checklist in `README.md`.

| Gate | Status |
|---|---|
| 50 MB `cat` stays responsive, echo under about 30 ms | Pending manual check |
| vim, htop, Option-as-Meta | Pending manual check |
| Cmd+K/F/C/V reach xterm, and a menu accelerator fires with xterm focused | Pending manual check |
| Ad-hoc-signed build receives a notification click with its thread id | Pending manual check |

If any of these fail, the Goal Capsule stop condition applies: record the failure here and re-plan before building on it.
