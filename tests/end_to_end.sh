#!/usr/bin/env bash
# End-to-end tests for the numimport CLI. Usage: end_to_end.sh <path-to-binary>
set -euo pipefail

BIN="$1"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
FAILED=0

expect_output() { # name input expected-output
    local name="$1" input="$2" expected="$3"
    printf '%s' "$input" > "$WORKDIR/in.csv"
    printf '%s' "$expected" > "$WORKDIR/want.csv"
    if ! "$BIN" "$WORKDIR/in.csv" > "$WORKDIR/got.csv" 2>"$WORKDIR/err.txt"; then
        echo "FAIL $name: expected exit 0, stderr:"; cat "$WORKDIR/err.txt"; FAILED=1; return
    fi
    if ! diff -u "$WORKDIR/want.csv" "$WORKDIR/got.csv"; then
        echo "FAIL $name: output mismatch"; FAILED=1
    fi
}

expect_failure() { # name input expected-stderr-keyword
    local name="$1" input="$2" keyword="$3"
    printf '%s' "$input" > "$WORKDIR/in.csv"
    if "$BIN" "$WORKDIR/in.csv" > /dev/null 2>"$WORKDIR/err.txt"; then
        echo "FAIL $name: expected non-zero exit"; FAILED=1; return
    fi
    if ! grep -qi "$keyword" "$WORKDIR/err.txt"; then
        echo "FAIL $name: stderr lacks '$keyword':"; cat "$WORKDIR/err.txt"; FAILED=1
    fi
}

# Two columns with different decimal separators; empty cell preserved.
expect_output "mixed columns" \
'1.5;1,5;
2.25;2,75;7
' \
'3/2;3/2;
9/4;11/4;7
'

# European thousands grouping with three-digit groups.
expect_output "thousands grouping" \
'1.234.567,89
2.000.000,00
' \
'123456789/100
2000000
'

# Whole column decides, not the first row: row 2 forces the comma.
expect_output "column-wide decision" \
'1,234
2,5
' \
'617/500
5/2
'

# Both interpretations valid but different -> ambiguity error.
expect_failure "ambiguity" '1,234
' "ambiguous"

# No consistent interpretation for the column.
expect_failure "no consistent format" '1,5
2.5
' "no consistent"

# Stdin works and empty input yields empty output.
if [ -n "$(printf '' | "$BIN" 2>/dev/null)" ]; then
    echo "FAIL empty input: expected empty output"; FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
    echo "all end-to-end tests passed"
else
    exit 1
fi
