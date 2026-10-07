#!/usr/bin/env bash
# The oracle alternates its verdict between runs; the tool must detect the
# unstable (bad) predicate and exit with code 2.
set -euo pipefail
BIN="$1"; SRC="$2"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

export FLAKY_STATE="$TMP/state"
cat > "$TMP/flaky.sh" <<'EOF'
#!/usr/bin/env bash
n=$(cat "$FLAKY_STATE" 2>/dev/null || echo 0)
echo $((n + 1)) > "$FLAKY_STATE"
exit $((n % 2))
EOF

set +e
"$BIN" --oracle "bash $TMP/flaky.sh" --input "$SRC/tests/data/crash.sexp" \
  --output "$TMP/out.sexp" --trace "$TMP/trace.jsonl" 2>"$TMP/err.log"
rc=$?
set -e

[ "$rc" -eq 2 ]
grep -q "unstable" "$TMP/err.log"

echo "flaky_predicate: PASS"
