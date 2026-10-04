# RESULTS

Environment: Node.js v22.22.1, offline, standard library only.
Command: `node --test` (run 2026-10-04).

## Summary

```
# tests 4        (test files)
# pass 4
# fail 0
```

Subtests per file (all passing, 25 total):

| File | Subtests | Pass | Fail |
|---|---|---|---|
| test/equiv.test.js | 13 | 13 | 0 |
| test/fuzz.test.js | 3 | 3 | 0 |
| test/snapshot.test.js | 6 | 6 | 0 |
| test/cli.test.js | 3 | 3 | 0 |

## Acceptance criteria mapping

1. **Reordered records, same partial order -> EQUAL**: `reordered log with
   same partial order is EQUAL`, `transitively redundant edges are normalized
   away` (test/equiv.test.js). PASS.
2. **One fewer causal edge -> UNDECIDED or NOT_EQUAL per rule**: subset of
   causal information -> `UNDECIDED` with `missing_edges`
   (`one fewer causal edge (subset) is UNDECIDED with missing_edges`);
   contradictory causes -> `NOT_EQUAL` with `first_divergent` +
   `minimal_frontier` (`contradictory causes are NOT_EQUAL ...`). PASS.
3. **Cyclic logs equivalent after SCC compression**: `cyclic logs are
   equivalent after SCC compression` (cycle `{x,y}` attached from different
   members in the two logs, still `EQUAL`; canonical SCCs `[['a'],['x','y']]`).
   PASS.
4. **n<=9 random partial orders vs brute-force closure normalization**:
   `random posets (n<=9): library matches brute-force closure rule`
   (500 seeded cases, all three statuses exercised and matching an
   independent naive fixpoint reference), plus 200 reduction-vs-full-edge
   `EQUAL` cases and 50 `NOT_EQUAL` cases whose `first_divergent` /
   `minimal_frontier` are verified against brute force. PASS.
5. **Boundaries**: truncated snapshot (3 cut points) -> `RESTORE_CORRUPT`
   with in-memory store and snapshot file untouched; bit-flip detected via
   SHA-256 checksum; duplicate `log_id` -> `INVALID_INPUT` without
   overwriting; empty logs (`EQUAL` vs `EQUAL`, `UNDECIDED` vs non-empty).
   PASS.

Scale: 3000-event logs (chain + redundant edges) compare `EQUAL` in ~1.5s
total suite time for the scale test file; one dropped cover edge is reported
as `UNDECIDED` with the exact missing edge `e122 -> e123`.

## Fuzz tally (seed 20261004, 500 random log pairs, n<=9)

All 500 library verdicts matched the brute-force reference exactly
(statuses `EQUAL` / `UNDECIDED` / `NOT_EQUAL` all exercised).
