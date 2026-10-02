# RESULTS

Environment: Node.js v22.22.1, standard library only, `node:test` runner.

Command: `node --test`

## Summary (real output, 2026-10-02)

```
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1404.897945
```

## Test files

| file | covers | result |
|---|---|---|
| `test/state-machine.test.js` | A: all legal/illegal transitions, terminal immutability, refund reversed once, E_NOT_FOUND/E_DUPLICATE/E_VALIDATION | ok |
| `test/nulls-currency.test.js` | B: NULL tip ignored in aggregation, NULL amount skipped, unknown currency unconverted in own bucket, NULL currency bucket | ok |
| `test/stats.test.js` | C: incremental materialized min/max/sum vs brute-force scan over 5000 generated events (10 merchants × 30 days), plus backtracking recompute from mid-range day | ok |
| `test/settlement.test.js` | D: chargeback reversal after settlement fails with E_LOCKED and no side effects; inclusive lock boundary (settleDay >= captureDay); per-merchant settlements | ok |
| `test/cli.test.js` | CLI: `apply events.jsonl --stats m d` prints JSON stats; errors exit non-zero with `{code,message}` on stderr (E_TRANSITION, E_LOCKED, E_IO, E_VALIDATION, E_USAGE) | ok |

## Notes

- The sandbox blocks child-process spawning (EPERM), so the CLI is tested
  in-process via `run(argv, io)` from `src/cli.js` — the exact entry point
  `bin/card.js` delegates to. The CLI was also verified end-to-end as a real
  process from the shell:
  - `node bin/card.js apply /tmp/ev.jsonl --stats m 2024-04-01` → exit 0, JSON stats on stdout
  - `node bin/card.js apply /tmp/bad.jsonl` → exit 1, `{"code":"E_NOT_FOUND",...}` on stderr
