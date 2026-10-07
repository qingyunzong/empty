#!/usr/bin/env bash
# The oracle never reproduces the failure on the original input; the tool
# must refuse to reduce and exit with code 2.
set -euo pipefail
BIN="$1"; SRC="$2"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

set +e
"$BIN" --oracle false --input "$SRC/tests/data/crash.sexp" \
  --output "$TMP/out.sexp" --trace "$TMP/trace.jsonl" 2>"$TMP/err.log"
rc=$?
set -e

[ "$rc" -eq 2 ]
grep -q "does not hold on the original input" "$TMP/err.log"
[ ! -s "$TMP/out.sexp" ]

echo "bad_predicate: PASS"
