# Test Results (recorded)

- Command: `npm test` (= `tsc -p tsconfig.json && node --test "dist/test/*.test.js"`)
- Date (UTC): 2026-10-05T08:23:27Z
- Node.js: v22.22.1, npm: 9.2.0, tsc: 7.0.2
- Exit code: 0

## Summary (TAP, aggregate)

```
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Per-test detail (spec reporter, per file)

### dist/test/crosscheck.test.js

```
✔ cross-check: exhaustive enumeration of small syntax trees (556.612381ms)
✔ cross-check: seeded random deeper trees (145.670188ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 754.124763
```

### dist/test/evaluate.test.js

```
✔ addition and subtraction of like dimensions (9.192714ms)
✔ multiplication and division merge dimension vectors (2.910744ms)
✔ dimensionless results and pure numbers (0.994504ms)
✔ powers scale the dimension vector (1.341513ms)
✔ exact rational arithmetic, no floating point drift (0.763932ms)
✔ dimension mismatch on + and - raises UnitError with ranges and units (4.922487ms)
✔ zero is NOT exempt from the dimension check (6.023853ms)
✔ mismatch inside a nested subexpression reports the inner range (2.167945ms)
✔ division by zero reports the subexpression range (4.263956ms)
✔ derived units agree with their base-unit expansion (2.911866ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 79.410637
```

### dist/test/parser.test.js

```
✔ precedence: * and / bind tighter than + and - (8.644086ms)
✔ implicit multiplication between adjacent primaries (1.259575ms)
✔ power binds to the preceding primary; unary minus stays outside (1.030817ms)
✔ parentheses override precedence and extend the range (0.940591ms)
✔ node ranges point back into the source (0.707587ms)
✔ parse errors carry a source range (2.382759ms)
✔ unit table: exact, prefixed, and derived units (1.074876ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 51.579424
```

### dist/test/rational.test.js

```
✔ construction normalizes to lowest terms (4.883656ms)
✔ arithmetic is exact (1.143775ms)
✔ decimal parsing is exact (no floating point) (2.246263ms)
✔ integer powers, including negative and zero (1.920758ms)
✔ zero handling (2.649269ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44.553462
```
