# RESULTS

Environment: Node.js v22.22.1, standard library only, offline. Command: `node --test`.

## Test run (real output)

```
$ node --test
ok 1 - test/cli.test.js
ok 2 - test/closure.test.js
ok 3 - test/equiv.test.js
ok 4 - test/scale.test.js
ok 5 - test/snapshot.test.js
# tests 5
# pass 5
# fail 0
```

28 subtests in total, all passing:

| File | Subtests | Result |
|---|---|---|
| test/equiv.test.js | 11 | ok |
| test/closure.test.js | 1 (300 random iterations) | ok |
| test/snapshot.test.js | 7 | ok |
| test/cli.test.js | 7 | ok |
| test/scale.test.js | 2 | ok |

## Acceptance criteria coverage

1. **换序但同偏序判 EQUAL** — `test/equiv.test.js` "reordered events, same
   partial order -> EQUAL" (shuffled event order + redundant transitive edge).
2. **少一条因果边按规则判定** — rule: a difference explainable by missing
   information (nested closures) is `UNDECIDED` with `missing_edges`; a
   positive contradiction (reversed edge / incomparable orders / state
   conflict) is `NOT_EQUAL` with `first_divergent` + `minimal_frontier`.
   Covered by "one missing causal edge -> UNDECIDED" and "reversed causal
   edge -> NOT_EQUAL".
3. **环日志压缩后等价** — "cyclic logs equivalent after SCC compression":
   reversed 3-cycle + different redundant edges collapse to the same SCC and
   compare `EQUAL`. `test/scale.test.js` also compresses a 3000-event cycle
   to a single SCC.
4. **n<=9 随机偏序对照暴力闭包** — `test/closure.test.js`: 300 seeded random
   posets; bitset closure cross-checked pair-by-pair against a brute-force
   DFS closure; closure-preserving variants compare `EQUAL`; single-edge
   removal/flip verdicts match the brute-force decision rule exactly.
5. **截断 snapshot / 重复 log_id / 空日志边界** —
   `test/snapshot.test.js`: truncated and checksum-tampered snapshots ->
   `RESTORE_CORRUPT` with in-memory state verified unchanged; duplicate
   `log_id` -> `INVALID_INPUT`; empty vs empty -> `EQUAL`, empty vs
   non-empty -> `UNDECIDED`. `test/cli.test.js` repeats the truncation check
   through the CLI and verifies the store file is untouched.

## Scale check (<=3000 events/shift)

`test/scale.test.js`: 3000-event chain with 5000 extra redundant edges —
`EQUAL` verdict, one removed chain edge -> `UNDECIDED` naming exactly that
edge in `missing_edges`, snapshot round-trip preserves verdicts. CLI timing
on the same shape: ingest ~0.3 s, equiv ~0.5 s.

## CLI exit codes (verified against real processes)

`EQUAL`=0, `NOT_EQUAL`=1, `UNDECIDED`=2, `INVALID_INPUT`=3,
`RESTORE_CORRUPT`=4.
