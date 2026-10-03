#!/usr/bin/env bash
# Runs the acceptance suite and records real stdout, stderr and the exit
# code into test-results.txt.
set -u
cd "$(dirname "$0")/.."
OUT=test-results.txt
STDOUT_FILE="$(mktemp)"
STDERR_FILE="$(mktemp)"
node --test >"$STDOUT_FILE" 2>"$STDERR_FILE"
CODE=$?
{
  echo "# test-results.txt"
  echo "# command: node --test"
  echo "# recorded: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# node: $(node --version)"
  echo ""
  echo "=== stdout ==="
  cat "$STDOUT_FILE"
  echo ""
  echo "=== stderr ==="
  cat "$STDERR_FILE"
  echo ""
  echo "=== exit code: $CODE ==="
} > "$OUT"
rm -f "$STDOUT_FILE" "$STDERR_FILE"
echo "recorded to $OUT (exit code: $CODE)"
exit "$CODE"
