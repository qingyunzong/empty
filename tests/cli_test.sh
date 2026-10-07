#!/usr/bin/env bash
set -euo pipefail
BIN="$1"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

run_case() {
    local name="$1" a="$2" b="$3" expected="$4"
    printf '%s\n' "$a" > "$TMP/a.txt"
    printf '%s\n' "$b" > "$TMP/b.txt"
    local out
    out=$("$BIN" "$TMP/a.txt" "$TMP/b.txt" 2>"$TMP/err.txt")
    if [[ "$out" != "$expected" ]]; then
        echo "FAIL $name"
        echo "  expected: $expected"
        echo "  got:      $out"
        exit 1
    fi
    # The stderr report must state the modulus/bound proof.
    grep -q "verified M > 2B" "$TMP/err.txt" || { echo "FAIL $name: missing proof line"; exit 1; }
    echo "ok $name"
}

run_case small "1 2 3" "4 5 6" "4 13 28 27 18"
run_case signs "-1 2 -3" "4 -5 6" "-4 13 -28 27 -18"
run_case cancel \
    "9223372036854775807 -9223372036854775807" \
    "9223372036854775807 9223372036854775807" \
    "85070591730234615847396907784232501249 0 -85070591730234615847396907784232501249"
run_case int64min \
    "-9223372036854775808" \
    "-9223372036854775808" \
    "85070591730234615865843651857942052864"

# stdin mode
out=$(printf '1 2 3\n4 5 6\n' | "$BIN" 2>/dev/null)
[[ "$out" == "4 13 28 27 18" ]] || { echo "FAIL stdin mode: $out"; exit 1; }
echo "ok stdin"

# error handling: garbage input must fail
if printf '1 x 3\n4 5 6\n' | "$BIN" >/dev/null 2>&1; then
    echo "FAIL: invalid input accepted"
    exit 1
fi
echo "ok invalid-input rejection"

echo "all cli tests passed"
