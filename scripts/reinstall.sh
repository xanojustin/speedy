#!/usr/bin/env bash
# Rebuilds Speedy.app and replaces /Applications/Speedy.app, quitting the running app first.
# Usage: ./scripts/reinstall.sh [--no-open]
set -euo pipefail

APP_NAME="Speedy"
DEST="/Applications/$APP_NAME.app"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"
# The installed app's process (the executable is lowercase `speedy`, like the shell command).
# Not `ps | grep -q`: grep exiting early SIGPIPEs ps, and pipefail turns a match into failure.
running() { [[ "$(ps -axo command=)" == *"$DEST/Contents/MacOS/"* ]]; }

open_after=1
for arg in "$@"; do
  case "$arg" in
    --no-open) open_after=0 ;;
    -h | --help)
      echo "Usage: $0 [--no-open]"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

# rustup installs cargo here; it may not be on PATH in a non-login shell.
export PATH="$HOME/.cargo/bin:$PATH"

cd "$ROOT"
echo "==> Installing dependencies"
bun install
echo "==> Building $APP_NAME.app"
bun run tauri build

# Quit through AppleScript so Speedy's exit hook runs and saves its preferences. Threads
# belong to This Mac's agent and keep running; with threads working, Speedy asks first.
# Refuse to replace the app while it's still running.
if running; then
  echo "==> Quitting $APP_NAME (threads keep running in This Mac's agent)"
  osascript -e "tell application \"$APP_NAME\" to quit" || true
  for _ in $(seq 1 30); do
    running || break
    sleep 0.5
  done
  if running; then
    echo "error: $APP_NAME is still running; quit it and run this again" >&2
    exit 1
  fi
fi

echo "==> Installing to $DEST"
rm -rf "$DEST"
ditto "$BUNDLE" "$DEST"

if [[ $open_after == 1 ]]; then
  open "$DEST"
fi
echo "==> Done"
