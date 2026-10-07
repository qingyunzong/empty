#!/usr/bin/env bash
# Runs the three acceptance scenarios against the real CLI and records the
# real stdout, stderr and exit code of every command into result.txt.
set -u
cd "$(dirname "$0")/.."
CLI="node src/cli.js"
OUT=result.txt
WORK=$(mktemp -d)
: > "$OUT"

record() {
  # record <label> <command...>
  local label="$1"; shift
  local stdout_file stderr_file code
  stdout_file=$(mktemp); stderr_file=$(mktemp)
  "$@" >"$stdout_file" 2>"$stderr_file"
  code=$?
  {
    echo "### $label"
    echo "\$ $*"
    echo "exit code: $code"
    echo "--- stdout ---"
    cat "$stdout_file"
    echo "--- stderr ---"
    cat "$stderr_file"
    echo
  } >> "$OUT"
}

{
  echo "device-window-stats acceptance run"
  echo "recorded: $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC)"
  echo "node: $(node --version)"
  echo
} >> "$OUT"

# ---------- Scenario 1: late down event splits an up window ----------
D1="$WORK/s1"; mkdir -p "$D1"
cat > "$D1/batch1.json" <<'JSON'
[{"id":"e1","device":"d1","ts":10000,"state":"up"},{"id":"e2","device":"d1","ts":20000,"state":"up"}]
JSON
cat > "$D1/batch2-late.json" <<'JSON'
[{"id":"e3","device":"d1","ts":11000,"state":"down"}]
JSON
{
  echo "============================================================"
  echo "SCENARIO 1: late down event splits an up window and corrects"
  echo "multiple buckets (retract + republish, no double counting)"
  echo "============================================================"
  echo
} >> "$OUT"
record "s1: append up@10000, up@20000 (watermark 20000)" $CLI append --dir "$D1" --file "$D1/batch1.json"
record "s1: query before the late event (windows fully up)" $CLI query --dir "$D1" --device d1 --from 10800 --to 12600
record "s1: append LATE down@11000 (behind watermark)" $CLI append --dir "$D1" --file "$D1/batch2-late.json"
record "s1: query after correction (window 10800 split 200s up / 700s down, version bumped)" $CLI query --dir "$D1" --device d1 --from 10800 --to 12600

# ---------- Scenario 2: windows before the first event are unknown ----------
D2="$WORK/s2"; mkdir -p "$D2"
cat > "$D2/first.json" <<'JSON'
[{"id":"e1","device":"d1","ts":50000,"state":"up"}]
JSON
{
  echo "============================================================"
  echo "SCENARIO 2: every window before the first event is unknown"
  echo "(uptime/downtime null, unknown = 900)"
  echo "============================================================"
  echo
} >> "$OUT"
record "s2: append first event at ts=50000" $CLI append --dir "$D2" --file "$D2/first.json"
record "s2: query windows entirely before the first event" $CLI query --dir "$D2" --device d1 --from 0 --to 2700
record "s2: query boundary window containing the first event" $CLI query --dir "$D2" --device d1 --from 49500 --to 50400

# ---------- Scenario 3: crash after append (replay) / before append (no-op) ----------
D3="$WORK/s3"; mkdir -p "$D3"
cat > "$D3/a.json" <<'JSON'
[{"id":"a1","device":"d1","ts":10000,"state":"up"},{"id":"a2","device":"d1","ts":13000,"state":"down"}]
JSON
cat > "$D3/b.json" <<'JSON'
[{"id":"b1","device":"d1","ts":16000,"state":"up"},{"id":"b2","device":"d1","ts":11000,"state":"down"}]
JSON
cat > "$D3/c.json" <<'JSON'
[{"id":"c1","device":"d1","ts":20000,"state":"down"}]
JSON
{
  echo "============================================================"
  echo "SCENARIO 3: crash injection"
  echo "  - crash after append, before index -> restart replays log"
  echo "  - crash before append -> batch has no effect"
  echo "  queries stay consistent across both crashes and compact"
  echo "============================================================"
  echo
} >> "$OUT"
record "s3: append batch A (normal)" $CLI append --dir "$D3" --file "$D3/a.json"
record "s3: append batch B with --crash=after-append (exit 75)" $CLI append --dir "$D3" --file "$D3/b.json" --crash=after-append
record "s3: query after restart (log replayed, batch B applied once)" $CLI query --dir "$D3" --device d1 --from 9900 --to 13500
record "s3: append batch C with --crash=before-append (exit 75)" $CLI append --dir "$D3" --file "$D3/c.json" --crash=before-append
record "s3: query again (batch C absent, results identical)" $CLI query --dir "$D3" --device d1 --from 9900 --to 13500
record "s3: compact (fold log into snapshot)" $CLI compact --dir "$D3"
record "s3: query after compact (still identical)" $CLI query --dir "$D3" --device d1 --from 9900 --to 13500

# ---------- node --test ----------
{
  echo "============================================================"
  echo "TEST SUITE: node --test"
  echo "============================================================"
  echo
} >> "$OUT"
record "node --test" node --test

echo "wrote $OUT"
