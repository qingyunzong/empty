# RESULTS

Environment: Node.js v22.22.1, standard library only, single machine, fully
offline (no network or external services used at any point). Date: 2026-10-04.

## Test run: `node --test`

Real output (TAP summary):

```
ok 1 - test/audit.test.js
ok 2 - test/cli.test.js
ok 3 - test/equiv.test.js
ok 4 - test/minimize.test.js
ok 5 - test/regex.test.js
ok 6 - test/state.test.js
# tests 6
# pass 6
# fail 0
```

Per-file subtests (all passing, 25 total):

| file | subtests | covers |
|---|---|---|
| test/audit.test.js | 6 | acceptance A (match + amount sums), B (BAD_LINE/BAD_REGEX), AMBIGUOUS_RULE, 50000-line and 80-char limits |
| test/cli.test.js | 6 | CLI audit/equiv/minimize/apply/snapshot/undo, error exit codes |
| test/equiv.test.js | 2 | acceptance C (independent enumeration cross-check) |
| test/minimize.test.js | 4 | partition certificates, verification, tamper rejection |
| test/regex.test.js | 3 | restricted-regex parser, BAD_REGEX incl. backreferences |
| test/state.test.js | 4 | acceptance D (apply/undo hash restore), NO_SNAPSHOT, no-state-write on failure |

## Acceptance criteria

- **A — valid rules hit and amounts sum correctly**
  (`test/audit.test.js` › "acceptance A"): 5-line ledger, rules
  `cny-credit` (flag) and `usd-any` (pass). Decisions came out
  `flag, flag, none, pass, none`; summary `flaggedCount: 2`,
  `flaggedByCurrency: { CNY: 300.75 }` (100.50 + 200.25, cent-exact).
- **B — invalid regex / out-of-bounds lines report codes and write no state**
  (`test/audit.test.js`, `test/state.test.js`, `test/cli.test.js`):
  13 malformed/out-of-bounds line variants (bad JSON, missing fields,
  negative amount, amount 1e13, bad direction/currency/timestamp, `|` in a
  field, oversized line) plus a 50001-line ledger all raise `BAD_LINE`;
  `a+`, `a{2}`, `(a)\1`, 81-char rules etc. raise `BAD_REGEX`. Failed
  `apply` leaves the state file absent/byte-identical (verified by
  re-reading the file before and after).
- **C — independent enumeration cross-check (length ≤ 8, alphabet {a,b,0,1})**
  (`test/equiv.test.js`): all 87381 strings of length ≤ 8 in
  (length, code-point) order are evaluated by an *independent* recursive
  AST matcher (no automata code). For 6 handcrafted equivalent pairs, 5
  handcrafted non-equivalent pairs (including an empty-string witness and
  multi-rule sets), 8 seeded-random pattern pairs and 2 random two-rule-set
  pairs, the library's `equiv` verdict, the witness string and its side all
  match the enumeration exactly — the witness is always the shortest, then
  numerically smallest distinguishing string.
- **D — consecutive applies then undo restores the previous hash**
  (`test/state.test.js`): apply(A) → hash `H_A`, snapshot, apply(B),
  apply(C), undo → state hash equals `H_A` and rules equal A. A second
  undo without a snapshot fails with `NO_SNAPSHOT` and the state file is
  byte-identical before/after.

## CLI verification (real invocations)

`node cli.js audit rules.json ledger.jsonl` (4-line ledger, CNY-credit flag
rule + USD pass rule):

```json
"summary": { "lines": 4, "flaggedCount": 2, "flaggedByCurrency": { "CNY": 300.75 } }
```

`node cli.js equiv a.json b.json` with `0*1*` vs `0*`,`1*`:

```json
{ "equiv": false, "witness": "01", "side": "A" }
```

`node cli.js minimize a.json` (`a*`): 2 minimized blocks,
`certificateValid: true`, certificate includes per-pair distinguishing
strings.

`apply a.json` → hash `bdea1a93…`, `snapshot`, `apply b.json` → hash
`5f4a3e1a…`, `undo` → hash `bdea1a93…` (restored). Second `undo`:

```json
{"error":{"code":"NO_SNAPSHOT","message":"no explicit snapshot to undo to"}}
```

`apply` with pattern `(a\1)` → exit 1,
`{"error":{"code":"BAD_REGEX","message":"backreferences are not supported"}}`,
and no state file is created. `audit` with a broken 5th line → exit 1,
`{"error":{"code":"BAD_LINE","message":"line 5: invalid JSON"}}`.

## Notes

- The CLI is also exercised in-process from `test/cli.test.js` via the
  exported `run()` function (`cli.js` is a thin wrapper around it), because
  this sandbox blocks child-process spawning; the real `node cli.js ...`
  invocations above were run separately and their outputs are pasted here.
- Amounts are summed per currency at cent precision (integer cents) to
  avoid binary floating-point drift.
