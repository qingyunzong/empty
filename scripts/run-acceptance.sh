#!/usr/bin/env bash
# Runs the acceptance suite and records real stdout, stderr and exit code.
set -u
cd "$(dirname "$0")/.."

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
node --test >"$stdout_file" 2>"$stderr_file"
code=$?

cli_stdout_file="$(mktemp)"
cli_stderr_file="$(mktemp)"
node src/cli.js trace examples/events.json -o /tmp/acceptance-result.json >"$cli_stdout_file" 2>"$cli_stderr_file"
cli_code=$?

{
  echo "# Acceptance run"
  echo "date_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node_version: $(node --version)"
  echo
  echo "## node --test"
  echo "exit_code: $code"
  echo
  echo "### stdout"
  cat "$stdout_file"
  echo
  echo "### stderr"
  cat "$stderr_file"
  echo
  echo "## node src/cli.js trace examples/events.json -o /tmp/acceptance-result.json"
  echo "exit_code: $cli_code"
  echo
  echo "### stdout"
  cat "$cli_stdout_file"
  echo
  echo "### stderr"
  cat "$cli_stderr_file"
} > test-results.txt

rm -f "$stdout_file" "$stderr_file" "$cli_stdout_file" "$cli_stderr_file"
echo "wrote test-results.txt (node --test exit_code=$code, cli exit_code=$cli_code)"
[ "$code" -eq 0 ] && [ "$cli_code" -eq 0 ]
