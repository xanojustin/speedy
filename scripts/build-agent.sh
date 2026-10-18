#!/usr/bin/env bash
# Builds speedy-agent and puts it where Tauri bundles it as a sidecar (KTD9):
# src-tauri/binaries/speedy-agent-<host triple>. Universal (arm64 + x86_64) when both Rust
# targets are installed, else the host architecture only. Re-signed ad hoc afterwards:
# `lipo` and the release profile's `strip` invalidate the linker's signature, and arm64
# macOS refuses to run unsigned code.
# Usage: ./scripts/build-agent.sh [--dev]   (--dev: debug build, host architecture only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"
MANIFEST="$ROOT/src-tauri/Cargo.toml"
TARGET_DIR="$ROOT/src-tauri/target"
HOST="$(rustc -vV | sed -n 's/^host: //p')"
OUT="$ROOT/src-tauri/binaries/speedy-agent-$HOST"
mkdir -p "$(dirname "$OUT")"
SHA="$(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo dev)"
export SPEEDY_BUILD_SHA="$SHA"

if [[ "${1:-}" == "--dev" ]]; then
  cargo build --manifest-path "$MANIFEST" -p speedy-agent
  cp "$TARGET_DIR/debug/speedy-agent" "$OUT"
else
  installed="$(rustup target list --installed 2>/dev/null || echo "$HOST")"
  built=()
  for t in aarch64-apple-darwin x86_64-apple-darwin; do
    if grep -qx "$t" <<<"$installed"; then
      cargo build --manifest-path "$MANIFEST" -p speedy-agent --release --target "$t"
      built+=("$TARGET_DIR/$t/release/speedy-agent")
    fi
  done
  if [[ ${#built[@]} -eq 2 ]]; then
    lipo -create -output "$OUT" "${built[@]}"
  else
    echo "warning: building speedy-agent for $HOST only; add the other target with" >&2
    echo "  rustup target add aarch64-apple-darwin x86_64-apple-darwin" >&2
    cp "${built[0]}" "$OUT"
  fi
fi
chmod 755 "$OUT"
codesign --force --sign - "$OUT"
"$OUT" version --json >/dev/null
echo "speedy-agent ($SHA) -> $OUT"
