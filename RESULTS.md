# Test Results

- Date: 2026-10-02
- Runtime: Node.js v22.22.1 (linux x64), standard library only, no network
- Command: `node --test`

## Summary (real output of `node --test`)

```
ok 1 - test/cli.test.js
ok 2 - test/cycles.test.js
ok 3 - test/engine.test.js
ok 4 - test/parse.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 10251.070695
```

4 test files, 27 subtests, **all passing** (27/27).

## Subtests (real output, per file)

### test/engine.test.js — 11/11 ok
```
ok 1 - acceptance 1: three-vehicle ring detected, then dissolved by a late cancel
ok 2 - ring certificate is stable while the ring persists
ok 3 - acceptance 2: intervals touching exactly at an endpoint do not create a wait
ok 4 - one millisecond of real overlap does create a wait
ok 5 - acceptance 4: duplicate reserveId raises DUP_RESERVE
ok 6 - duplicate reserveId is rejected even after the first was canceled
ok 7 - ping referencing an unknown agv raises UNKNOWN_AGV
ok 8 - retract of a ping removes occupancy evidence and invalidates the cycle
ok 9 - retract of a reserve removes its wait edges
ok 10 - unconfirmed reserve (no ping in window) does not hold an edge
ok 11 - buildWaitEdges is deterministic regardless of reserve array order
```

### test/cycles.test.js — 3/3 ok
```
ok 1 - acceptance 3: exhaustive <=4-agv overlap patterns match reference cycles
ok 2 - findCycles finds disjoint and nested cycles
ok 3 - acyclic graphs yield no cycles
```
Acceptance 3 sweeps 81 + 729 + 6561 = 7371 overlap configurations for
2/3/4 AGVs in ring topology and cross-checks every detected cycle set
against an independent brute-force permutation reference.

### test/cli.test.js — 7/7 ok
```
ok 1 - CLI end-to-end: ring detected, late cancel invalidates it, all four outputs written
ok 2 - CLI: active ring lands in cycles.json with evidence
ok 3 - CLI: ping for unknown agv exits 1 with UNKNOWN_AGV
ok 4 - CLI: duplicate reserveId exits 1 with DUP_RESERVE
ok 5 - CLI: malformed input exits 1 with BAD_JSON
ok 6 - CLI: missing arguments exits 2 with usage
ok 7 - CLI: events are merged from multiple jsonl files in sorted order
```

### test/parse.test.js — 6/6 ok
```
ok 1 - parses well-formed JSONL and tracks source positions
ok 2 - rejects invalid JSON with BAD_JSON
ok 3 - rejects unknown op with INVALID_EVENT
ok 4 - rejects missing required fields
ok 5 - rejects non-numeric eventTs
ok 6 - rejects unknown retract kind
```

## Acceptance criteria mapping

1. Three-vehicle ring dissolved by a late cancel → `test/engine.test.js` #1
   and `test/cli.test.js` #1 (invalid.jsonl keeps the original certificate
   hash; late.log records the late cancel at watermark 98000).
2. Endpoint-touching intervals do not count as waiting →
   `test/engine.test.js` #3 (and #4 proves 1ms of real overlap does count).
3. Exhaustive <=4-AGV overlap cross-check of cycles →
   `test/cycles.test.js` #1 (7371 configurations vs brute-force reference).
4. Duplicate reserveId → `test/engine.test.js` #5/#6 and
   `test/cli.test.js` #4, all raising `DUP_RESERVE`.
