#!/bin/zsh
# U1 throwaway: does a later claude process continue a session an earlier one started?
out="$HOME/speedy-u1/4-resume.txt"; CLAUDE=/opt/homebrew/bin/claude; cd "$HOME/speedy-u1"
{
  id=$($CLAUDE -p "Remember the number 7341. Reply with just: ok" --model haiku --output-format json </dev/null | /usr/bin/plutil -extract session_id raw -o - - 2>/dev/null)
  echo "session=$id"
  echo "--- resumed answer"
  $CLAUDE --resume "$id" -p "What number did I ask you to remember? Reply with just the number." --model haiku </dev/null 2>&1 | head -3
  echo "done"
} > "$out" 2>&1
