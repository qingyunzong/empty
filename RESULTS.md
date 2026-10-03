# RESULTS

Environment: Node.js v22.22.1, standard library only, offline, single machine.
Recorded: 2026-10-03T18:48:57Z (UTC). All outputs below are real runs.

## `node --test`

```
ok 1 - test/cli.test.js
ok 2 - test/eventbus.test.js
# tests 2
# pass 2
# fail 0
```

### test/eventbus.test.js (acceptance criteria)

```
ok 1 - acceptance 1: concurrent branches are distinguished from real ordering
ok 2 - acceptance 2: cycle A->B->C->A yields one SCC and consistent reachability
ok 3 - acceptance 3: random partial orders (n<=9) match brute-force transitive closure
ok 4 - acceptance 4: rollback across checkpoints restores events, edges and queries
ok 5 - acceptance 4b: failed rollback keeps state and reports ROLLBACK_RANGE
ok 6 - acceptance 5: duplicate id, missing endpoint, negative k report INVALID_INPUT
ok 7 - scale: 4000 events replay and query within reasonable effort
# tests 7
# pass 7
# fail 0
```

### test/cli.test.js

```
ok 1 - cli: JSONL replay produces per-line results and coded errors
ok 2 - cli: bundled example replay.jsonl produces expected causal analysis
# tests 2
# pass 2
# fail 0
```

Total: 9/9 subtests passing (7 library + 2 CLI).

## Acceptance mapping

1. **Concurrent branches vs real order** — `root` causes `a1/a2/a3` (same
   ts=200): `query(root,a1)=REACHABLE`, `query(a1,root)=NOT_REACHABLE`,
   `query(a1,a2)=CONCURRENT`, and unrelated different-ts pairs give
   `UNDECIDED` (never `NOT_REACHABLE`).
2. **A→B→C→A** — `scc()` returns `[["A","B","C"]]`; all pairs inside the
   cycle are mutually `REACHABLE`, the cycle reaches downstream `D`, and
   `query(D,A)=NOT_REACHABLE`. A second cycle `X↔Y` is reported as its
   own sorted component.
3. **Random partial orders, n≤9** — 300 seeded trials; for every ordered
   pair, library `REACHABLE` exactly matches a Floyd–Warshall brute-force
   transitive closure, and incomparable pairs follow the ts rule
   (`CONCURRENT` iff equal ts, else `UNDECIDED`).
4. **Layered checkpoints** — `rollback(1)` twice unwinds two layers
   (events, edges and query results verified after each step);
   `rollback(2)` spans two layers at once; `rollback(k>layers)` throws
   `ROLLBACK_RANGE` with state byte-identical before/after.
5. **INVALID_INPUT** — duplicate id, link with missing endpoint,
   negative/non-integer k, malformed observe payloads, query with unknown
   endpoint; rejected ops leave state untouched.

## CLI demo: `node src/cli.js examples/replay.jsonl`

```
{"line":1,"op":"observe","ok":true}
{"line":2,"op":"observe","ok":true}
{"line":3,"op":"observe","ok":true}
{"line":4,"op":"observe","ok":true}
{"line":5,"op":"checkpoint","ok":true,"layer":1}
{"line":6,"op":"link","ok":true}
{"line":7,"op":"link","ok":true}
{"line":8,"op":"query","ok":true,"result":"REACHABLE"}
{"line":9,"op":"query","ok":true,"result":"CONCURRENT"}
{"line":10,"op":"query","ok":true,"result":"UNDECIDED"}
{"line":11,"op":"scc","ok":true,"components":[]}
{"line":12,"op":"rollback","ok":true}
{"line":13,"op":"query","ok":true,"result":"UNDECIDED"}
```

Line 8: `fault-7 → temp-spike → alarm-a`, so the alarm is causally
explained by the prior fault (`REACHABLE`). Line 9: `alarm-a`/`alarm-b`
share ts 1712300003 with no causal link (`CONCURRENT`). Line 13: after
`rollback(1)` the links are undone, so the same query degrades to
`UNDECIDED` — not `NOT_REACHABLE`.

Stdin mode (`node src/cli.js -`) produces byte-identical output
(verified via md5: d1c44740ec4957c720fe6166431244ae for both modes).
