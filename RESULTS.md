# Test Results

- Date: 2026-10-03
- Runtime: Node.js v22.22.1 (standard library only, `node:test`)
- Command: `node --test`

## Summary

All suites pass: **30/30 individual tests, 3/3 files, 0 failures.**

| Suite | Tests | Pass | Fail | Covers |
| --- | --- | --- | --- | --- |
| `test/dsl.test.js` | 12 | 12 | 0 | lexer, Pratt parser, static types (acceptance 3), error codes |
| `test/semantics.test.js` | 9 | 9 | 0 | split→reverse→restated (acceptance 1), sell+reverse boundary (acceptance 2), ordering, CLI |
| `test/fuzz.test.js` | 9 | 9 | 0 | random lots/actions vs independent FIFO reference (acceptance 4) |

## `node --test` (full run, raw tail)

```
1..3
# tests 3
# suites 0
# pass 3
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

## Per-file detail (`node --test-reporter=spec <file>`)

### test/dsl.test.js
```
✔ lexer recognizes securities, ratios, ex-dates, versions, cash
✔ Pratt parser respects precedence and parentheses
✔ fraction ratios evaluate through the Pratt parser
✔ split ratio > 1 is rejected statically (E_RATIO)
✔ cash used where a share ratio is expected (E_RATIO)
✔ share ratio used where cash is expected (E_RATIO)
✔ mixing cash and shares in one expression (E_RATIO)
✔ invalid calendar dates (E_DATE)
✔ reversal lifecycle errors (E_REVERSE)
✔ reversal before the action ex-date (E_DATE)
✔ sell exceeding holdings (E_LOT)
✔ malformed lots input (E_LOT / E_DATE)
ℹ tests 12 / pass 12 / fail 0
```

### test/fuzz.test.js
```
✔ random program matches independent FIFO reference (seed 1)
✔ random program matches independent FIFO reference (seed 7)
✔ random program matches independent FIFO reference (seed 42)
✔ random program matches independent FIFO reference (seed 1337)
✔ random program matches independent FIFO reference (seed 20240)
✔ random program matches independent FIFO reference (seed 555)
✔ random program matches independent FIFO reference (seed 9001)
✔ random program matches independent FIFO reference (seed 31337)
✔ fuzz programs are deterministic across runs
ℹ tests 9 / pass 9 / fail 0
```

### test/semantics.test.js
```
✔ split, withdrawal, then restatement (RESTATED only affects post-ex lots)
✔ reversal after partial sell: shortfall becomes payable, never negative
✔ reversal after selling an entire lot: full shortfall is payable
✔ dividend reversal claws back cash; shortfall becomes cash payable
✔ tender reversal restores lots or books a receivable
✔ same ex-date same security: order by version, then hash tie-break
✔ security scopes are isolated; actions on one security compose in order
✔ CLI: corp apply actions.ca lots.json --ledger
✔ CLI: static errors are reported with their code and exit 1
ℹ tests 9 / pass 9 / fail 0
```

## Acceptance mapping

1. **拆股后撤销再重述** — `semantics.test.js › split, withdrawal, then restatement`:
   `split 1/2` → `reverse` → `restated split 1/4`; pre-ex lot returns to 100,
   post-ex lot goes 50 → 200, ledger keeps APPLY/REVERSE/RESTATED history.
2. **卖出部分 lot 后冲正边界** — `reversal after partial sell` and
   `reversal after selling an entire lot`: FIFO 回溯，shortfall booked as
   `payable` shares, positions never negative.
3. **非法比例与现金混用报错** — `dsl.test.js`: split ratio > 1, cash where a
   ratio is expected, ratio where cash is expected, `$0.5 + 1` mixing →
   all static `E_RATIO`; bad dates → `E_DATE`.
4. **随机对照** — `fuzz.test.js`: 8 seeded random programs (splits,
   dividends, tenders, FIFO sells across up to 3 securities) verified
   lot-by-lot and cash against an independent FIFO reference model.
