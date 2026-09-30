#!/usr/bin/env bash
# Human-in-the-loop reproduction loop.
# The agent copies this file and edits the steps. The user runs it in their
# own terminal: the agent's shell has no terminal for the prompts.
#
# Usage:
#   bash hitl-loop.sh [result-file]     (default: ./hitl-result.env)
#
# Two helpers:
#   step "<instruction>"          → show instruction, wait for Enter
#   capture VAR "<question>"      → show question, read the answer into VAR
#
# At the end, captured values are written as KEY=VALUE lines to the result
# file, which the agent reads. Capture observations only, never secrets:
# leave signing in to the user as a `step`.

set -euo pipefail

OUT="${1:-./hitl-result.env}"

if [ ! -t 0 ]; then
  echo "Run this in your own terminal: it asks you questions." >&2
  exit 1
fi

step() {
  printf '\n>>> %s\n' "$1"
  read -r -p "    [Enter when done] " _
}

capture() {
  local var="$1" question="$2" answer
  printf '\n>>> %s\n' "$question"
  read -r -p "    > " answer
  printf -v "$var" '%s' "$answer"
}

# --- edit below ---------------------------------------------------------

step "Open the app at http://localhost:3000 and sign in."

capture ERRORED "Click the 'Export' button. Did it throw an error? (y/n)"

capture ERROR_MSG "Paste the error message (or 'none'):"

# --- edit above ---------------------------------------------------------

{
  printf 'ERRORED=%s\n' "$ERRORED"
  printf 'ERROR_MSG=%s\n' "$ERROR_MSG"
} > "$OUT"
printf '\nSaved to %s. Tell the agent you are done.\n' "$OUT"
