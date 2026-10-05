# causal-log-orderer

Deterministic causal (topological) ordering for multi-source event logs,
with incremental revision, conflict evidence and snapshots.
TypeScript + Node.js **built-in libraries only** (no npm dependencies;
`tsc` is used only to compile).

## Event model

Each log line (JSONL) is one event:

```json
{"id":"a1","source":"A","seq":1,"ts":100,"deps":["b1","b2"]}
```

- `id` — globally unique event id
- `source` — source (replica) id, `seq` — per-source sequence number
- `ts` — timestamp; **not required to be causally monotonic** (a child may
  carry a smaller timestamp than its parent — causality still wins)
- `deps` — predecessor event ids

## Deterministic order

Kahn's algorithm with a min-heap over ready candidates: each round, among
all events whose dependencies are already emitted, the candidate with the
smallest key `(ts, source, seq, id)` is emitted next. The result is the
lexicographically smallest linear extension under that key — verified on
small graphs by enumerating **all** topological orders (`src/topo.ts`,
`enumerateOrders`) and checking the greedy output equals the minimum.

Diagnostics (evidence):

- **Missing dependencies** — events depending on unknown ids (directly or
  transitively) are withheld; `diagnostics.missing` maps each missing id to
  its direct dependents, `diagnostics.withheld` maps each withheld event to
  its root missing ids.
- **Cycles** — `diagnostics.cycles` lists concrete cycles; in each
  `[x0..xk]`, every `xi` depends on `x(i+1)` and `xk` depends on `x0`.

## Incremental causal revision

State = known events + a **published prefix** (fixed) + an unpublished
region (reorderable). A revision batch adds events and/or dependencies:

```jsonl
{"id":"c1","source":"C","seq":1,"ts":5,"deps":["a1"]}
{"addDep":{"id":"a2","dep":"b1"}}
```

Rules (`src/state.ts`, `revise`):

- The published prefix is fixed. If any new dependency would require
  inverting it (a published event gains an ancestor that is unpublished or
  published later, or a missing dependency is attached to a published
  event), the **whole batch is rejected atomically** and the **shortest
  conflict chain(s)** are returned (BFS over "depends-on" edges from each
  published event; chain `[a..p]` means `a` must precede published `p`).
- Otherwise the batch is applied and only the unpublished region is
  reordered.

## Snapshots

`toSnapshot`/`fromSnapshot` (`src/state.ts`) persist the events, the
published prefix, the derived **ready-candidate set** and the
**missing-dependency index**. On load, the derived data is recomputed and
must match, so tampered or stale snapshots are rejected. Property tests
cross-check random revision sequences + snapshot round-trips against a
full-graph rebuild from raw inputs.

## CLI

```sh
npm run build   # tsc -> dist/

node dist/src/cli.js order <log.jsonl> [--enumerate] [--snapshot s.json]
node dist/src/cli.js publish <s.json> <count> --out <s2.json>
node dist/src/cli.js revise <s2.json> <batch.jsonl> --out <s3.json>
node dist/src/cli.js show <s3.json> [--enumerate]
```

Exit codes: `0` ok, `1` error, `2` revision rejected (conflict chains on
stdout, no snapshot written). Small graphs (≤10 emittable events, or
`--enumerate`) are cross-checked by full enumeration of topological orders.

## Tests

```sh
npm test        # tsc -p tsconfig.json && node --test "dist/test/**/*.test.js"
```

Covers: heap ordering; deterministic order and tie-breaks; non-monotonic
timestamps; missing-dep and cycle evidence; greedy-vs-enumeration on 300
random small DAGs; revision accept/reject incl. shortest-conflict-chain
minimality (independent BFS) and atomicity; 120 random revision trials
vs full rebuild; snapshot round-trip/tamper; CLI end-to-end.

### Actual results (recorded 2026-10-06, Node v22.22.1, tsc 7.0.2)

```
# Subtest: dist/test/cli.test.js         ok (3 tests)
# Subtest: dist/test/heap.test.js        ok (2 tests)
# Subtest: dist/test/incremental.test.js ok (8 tests)
# Subtest: dist/test/snapshot.test.js    ok (5 tests)
# Subtest: dist/test/topo.test.js        ok (7 tests)
# tests 25
# pass 25
# fail 0
```
