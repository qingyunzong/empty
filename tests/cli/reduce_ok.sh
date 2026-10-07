#!/usr/bin/env bash
# End-to-end: reduction reaches a 1-minimal result, the trace is complete,
# and the persistent cache (keyed with the environment ID) is reused.
set -euo pipefail
BIN="$1"; SRC="$2"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/oracle.sh" <<'EOF'
#!/usr/bin/env bash
# failure reproduces iff the candidate still mentions `crash`
grep -qw crash "$1"
EOF

"$BIN" --oracle "bash $TMP/oracle.sh" --input "$SRC/tests/data/crash.sexp" \
  --output "$TMP/out.sexp" --trace "$TMP/trace.jsonl" \
  --cache-file "$TMP/cache.db" 2>"$TMP/stderr.log"

# Result still reproduces the failure and is genuinely reduced.
grep -qw crash "$TMP/out.sexp"
! grep -qw prog "$TMP/out.sexp"
! grep -qw def "$TMP/out.sexp"
! grep -qw call "$TMP/out.sexp"

# Trace completeness: start + one line per trial + done, 1-minimal flag set.
grep -q '"type":"start"' "$TMP/trace.jsonl"
grep -q '"type":"done"' "$TMP/trace.jsonl"
grep -q '"one_minimal":true' "$TMP/trace.jsonl"
trials=$(grep -c '"type":"trial"' "$TMP/trace.jsonl")
reported=$(grep -o '"trials":[0-9]*' "$TMP/trace.jsonl" | tail -1 | cut -d: -f2)
[ "$trials" -gt 0 ]
[ "$trials" = "$reported" ]

# Second run with the same cache file: same environment ID => cache hits,
# identical output.
"$BIN" --oracle "bash $TMP/oracle.sh" --input "$SRC/tests/data/crash.sexp" \
  --output "$TMP/out2.sexp" --trace "$TMP/trace2.jsonl" \
  --cache-file "$TMP/cache.db" 2>/dev/null
grep -q '"cache":"hit"' "$TMP/trace2.jsonl"
cmp "$TMP/out.sexp" "$TMP/out2.sexp"

# A different --env-id changes cache keys, so nothing is reused.
"$BIN" --oracle "bash $TMP/oracle.sh" --input "$SRC/tests/data/crash.sexp" \
  --output "$TMP/out3.sexp" --trace "$TMP/trace3.jsonl" \
  --cache-file "$TMP/cache.db" --env-id other 2>/dev/null
! grep -q '"cache":"hit"' "$TMP/trace3.jsonl"
cmp "$TMP/out.sexp" "$TMP/out3.sexp"

echo "reduce_ok: PASS"
