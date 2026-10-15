#!/bin/sh
# Opens folders in Speedy, like `code .` (default: the current folder).
# Installed by Speedy > Install 'speedy' Command in PATH.
[ $# -eq 0 ] && set -- .
for dir in "$@"; do
  shift
  abs=$(cd -- "$dir" 2>/dev/null && pwd -P) || {
    echo "speedy: not a folder: $dir" >&2
    exit 1
  }
  set -- "$@" "$abs"
done
exec open -b dev.brecht.speedy "$@"
