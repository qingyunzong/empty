#!/usr/bin/env bash
# Runs node --test plus the three acceptance CLI scenarios and records the
# real exit code, stdout and stderr of every command into result.txt.
set -u
cd "$(dirname "$0")/.."

OUT=result.txt
: > "$OUT"

run() {
  local stdout_file stderr_file code
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)
  {
    echo "================================================================"
    echo "\$ $*"
  } >> "$OUT"
  "$@" > "$stdout_file" 2> "$stderr_file"
  code=$?
  {
    echo "exit_code: $code"
    echo "--- stdout ---"
    cat "$stdout_file"
    echo "--- stderr ---"
    cat "$stderr_file"
    echo
  } >> "$OUT"
  rm -f "$stdout_file" "$stderr_file"
}

S1=$(mktemp -d /tmp/mrp-s1.XXXXXX)
S2=$(mktemp -d /tmp/mrp-s2.XXXXXX)
S3=$(mktemp -d /tmp/mrp-s3.XXXXXX)

run node --test

# Scenario 1: two work orders sharing multi-level components; the reference
# path enumeration must reproduce the gross requirements.
run node src/cli.js apply scenarios/s1.json --data "$S1"
run node src/cli.js paths --data "$S1"
run node src/cli.js query --data "$S1"

# Scenario 2: inventory corrected null -> 0 flips net from null to a real
# shortage; correcting an unknown key must fail with exit 1.
run node src/cli.js apply scenarios/s2a.json --data "$S2"
run node src/cli.js query --data "$S2"
run node src/cli.js apply scenarios/s2b.json --data "$S2"
run node src/cli.js query --data "$S2"
run node src/cli.js apply scenarios/s2bad.json --data "$S2"
run node src/cli.js query --data "$S2"

# Scenario 3: crash injection. before_append leaves no trace; after_append
# persists the log without a snapshot and the restart query recovers by replay.
run node src/cli.js apply scenarios/s3a.json --data "$S3"
run node src/cli.js apply scenarios/s3b.json --data "$S3" --fail before_append
run node src/cli.js query --data "$S3"
run node src/cli.js apply scenarios/s3b.json --data "$S3" --fail after_append
run node src/cli.js query --data "$S3"
