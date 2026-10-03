#!/usr/bin/env bash
# Runs `node --test` and the three CLI acceptance scenarios, recording real
# exit codes, stdout and stderr into result.txt.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
CLI="node $ROOT/src/cli.js"
OUT="$ROOT/result.txt"
WORK="$(mktemp -d /tmp/mrp-acceptance-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

: > "$OUT"

record() { # <title> <exit> <stdout-file> <stderr-file>
  {
    echo "=== $1 ==="
    echo "exit_code: $2"
    echo "--- stdout ---"
    cat "$3"
    echo "--- stderr ---"
    cat "$4"
    echo
  } >> "$OUT"
}

run_cmd() { # <title> <cmd...>
  local title="$1"; shift
  "$@" >"$WORK/stdout" 2>"$WORK/stderr"
  local code=$?
  record "$title" "$code" "$WORK/stdout" "$WORK/stderr"
  return $code
}

# ---------------------------------------------------------------- node --test
run_cmd "node --test" node --test

# ------------------------------------------------- scenario 1: shared BOM
S1="$WORK/s1"; mkdir -p "$S1"
cat > "$S1/ev1.json" <<'JSON'
{"events":[
  {"op":"insert","entity":"workorder","key":{"id":"WO1"},"value":{"product":"P1","qty":5}},
  {"op":"insert","entity":"workorder","key":{"id":"WO2"},"value":{"product":"P2","qty":2}},
  {"op":"insert","entity":"bom","key":{"parent":"P1","component":"A"},"value":{"usage":2}},
  {"op":"insert","entity":"bom","key":{"parent":"P1","component":"B"},"value":{"usage":1}},
  {"op":"insert","entity":"bom","key":{"parent":"A","component":"C"},"value":{"usage":3}},
  {"op":"insert","entity":"bom","key":{"parent":"B","component":"C"},"value":{"usage":4}},
  {"op":"insert","entity":"bom","key":{"parent":"C","component":"D"},"value":{"usage":2}},
  {"op":"insert","entity":"bom","key":{"parent":"P2","component":"A"},"value":{"usage":1}},
  {"op":"insert","entity":"inventory","key":{"component":"A"},"value":{"qty":4}},
  {"op":"insert","entity":"inventory","key":{"component":"B"},"value":{"qty":10}},
  {"op":"insert","entity":"inventory","key":{"component":"C"},"value":{"qty":null}},
  {"op":"insert","entity":"inventory","key":{"component":"D"},"value":{"qty":100}}
]}
JSON
run_cmd "scenario 1: apply work orders + BOM + inventory" $CLI apply "$S1/ev1.json" --dir "$S1/data"
run_cmd "scenario 1: query net requirements (shared multi-level components)" $CLI query --dir "$S1/data"

# --------------------------------------- scenario 2: null -> 0 correction
S2="$WORK/s2"; mkdir -p "$S2"
cat > "$S2/ev1.json" <<'JSON'
{"events":[
  {"op":"insert","entity":"workorder","key":{"id":"WO9"},"value":{"product":"P9","qty":1}},
  {"op":"insert","entity":"bom","key":{"parent":"P9","component":"C9"},"value":{"usage":5}},
  {"op":"insert","entity":"inventory","key":{"component":"C9"},"value":{"qty":null}}
]}
JSON
cat > "$S2/ev2.json" <<'JSON'
{"events":[
  {"op":"correct","entity":"inventory","key":{"component":"C9"},"value":{"qty":0}}
]}
JSON
cat > "$S2/ev3.json" <<'JSON'
{"events":[
  {"op":"correct","entity":"inventory","key":{"component":"NOPE"},"value":{"qty":1}}
]}
JSON
run_cmd "scenario 2: apply setup (inventory qty null = unknown)" $CLI apply "$S2/ev1.json" --dir "$S2/data"
run_cmd "scenario 2: query (net must be null, not 0)" $CLI query --dir "$S2/data"
run_cmd "scenario 2: correct inventory null -> 0" $CLI apply "$S2/ev2.json" --dir "$S2/data"
run_cmd "scenario 2: query (net becomes definite shortage)" $CLI query --dir "$S2/data"
run_cmd "scenario 2: correct unknown key (must fail, exit 1)" $CLI apply "$S2/ev3.json" --dir "$S2/data"

# ------------------------------------------------- scenario 3: crash points
S3="$WORK/s3"; mkdir -p "$S3"
cat > "$S3/ev1.json" <<'JSON'
{"events":[
  {"op":"insert","entity":"workorder","key":{"id":"WO1"},"value":{"product":"P1","qty":2}},
  {"op":"insert","entity":"bom","key":{"parent":"P1","component":"C1"},"value":{"usage":3}},
  {"op":"insert","entity":"inventory","key":{"component":"C1"},"value":{"qty":1}}
]}
JSON
cat > "$S3/ev2.json" <<'JSON'
{"events":[
  {"op":"correct","entity":"inventory","key":{"component":"C1"},"value":{"qty":10}}
]}
JSON
run_cmd "scenario 3: apply setup" $CLI apply "$S3/ev1.json" --dir "$S3/data"
run_cmd "scenario 3: query baseline (v1)" $CLI query --dir "$S3/data"
run_cmd "scenario 3: apply --fail before_append (exit 1, no effect)" $CLI apply "$S3/ev2.json" --dir "$S3/data" --fail before_append
run_cmd "scenario 3: query after before_append crash (still v1)" $CLI query --dir "$S3/data"
run_cmd "scenario 3: apply --fail after_append (exit 1, log persisted, snapshot stale)" $CLI apply "$S3/ev2.json" --dir "$S3/data" --fail after_append
run_cmd "scenario 3: query after restart (replay recovery to v2)" $CLI query --dir "$S3/data"

echo "result.txt written to $OUT"
