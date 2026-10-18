#!/bin/zsh
# U1 throwaway: what `claude` can do from a given launch context. Usage: probe.sh <label>
label="$1"; out="$HOME/speedy-u1/$label.txt"; mkdir -p "$HOME/speedy-u1"
CLAUDE=/opt/homebrew/bin/claude
{
  echo "label=$label pid=$$ ppid=$PPID sid=$(ps -o sess= -p $$ 2>/dev/null) date=$(date +%T)"
  echo "managername=$(launchctl managername 2>&1)"
  echo "PATH=$PATH"
  echo "token_env=${CLAUDE_CODE_OAUTH_TOKEN:+set}"
  echo "--- auth status"; $CLAUDE auth status 2>&1 | head -12
  echo "--- -p hi"; $CLAUDE -p "Reply with just the word pong." --model haiku 2>&1 | head -5
  echo "--- ls Documents"; ls "$HOME/Documents" >/dev/null 2>&1 && echo "documents=ok" || echo "documents=DENIED ($?)"
  echo "--- ls Desktop"; ls "$HOME/Desktop" >/dev/null 2>&1 && echo "desktop=ok" || echo "desktop=DENIED ($?)"
  echo "done"
} > "$out" 2>&1
