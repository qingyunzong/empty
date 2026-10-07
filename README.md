# numimport

CSV number-import tool (C++20). For every column it picks `.` or `,` as the
decimal separator by examining **all** rows — never guessing from the first
row — and rewrites numbers as exact fractions.

## Rules

- The separator not used as decimal separator acts as a thousands separator
  and is only legal between digit groups of exactly three (`1,234,567` ok,
  `12,34` rejected as thousands).
- If both interpretations are legal for a whole column but yield different
  values (e.g. `1,234` = 1234 vs 617/500), the tool reports an ambiguity
  error and exits non-zero. If both are legal and agree everywhere (plain
  integers), either is used silently.
- If no single separator fits every row, the column is reported as
  inconsistent; a column containing non-numeric text passes through unchanged.
- Numbers are emitted as reduced exact fractions (`1.50` -> `3/2`,
  `1,234.5` -> `2469/2`); integers print without a denominator.
- Empty cells stay empty.

## Usage

```
numimport [--header] [file|-]     # reads stdin when no file is given
```

`--header` treats the first row as a header and passes it through unchanged.

## Build & test

```
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

Tests: unit suites (`parser`, `column`, `csv`), an `exhaustive` suite that
cross-checks every string over `{0,1,.,,}` up to length 7 (plus signed
variants) against an independent regex/gcd reference implementation, and a
`cli_end_to_end` suite driving the real binary.
