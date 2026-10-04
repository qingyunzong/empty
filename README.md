# shiftlog-equiv

Offline merge and equivalence checking for shift device-state logs.
Node.js 22 standard library only; no dependencies; fully offline.

Each shift records events with causal predecessors offline. After handover,
two logs are compared as **partial orders**: events are nodes, `causes` are
directed edges (`u -> v` means `u` happens-before `v`). Cycles are compressed
into strongly connected components (SCCs); the canonical form is the
condensation DAG plus its transitive reduction.

## Comparison rules (deterministic)

| Status | Meaning |
|---|---|
| `EQUAL` | Same event universe, no dangling causes, identical reachability. Record order and transitively redundant edges are irrelevant. |
| `UNDECIDED` | No contradiction, but information is missing: an event exists in only one log, one side's reachability is a strict subset of the other's, or a cause references an event absent from that log (`dangling_cause`). Missing information is never reported as inconsistency. |
| `NOT_EQUAL` | Genuine conflict: each log implies a causal pair (on shared events) that the other denies. |
| `INVALID_INPUT` | Malformed events, duplicate `log_id`, unknown logs, merge conflicts. |
| `RESTORE_CORRUPT` | Snapshot file unreadable, truncated, tampered, or wrong format. |

Precedence: `NOT_EQUAL` > `UNDECIDED` > `EQUAL`.

- `NOT_EQUAL` reports `first_divergent` (smallest event id whose ancestor set
  differs) and `minimal_frontier` (the transitive-reduction edges inside its
  past cone that the logs disagree on — a minimal inconsistent predecessor set).
- `UNDECIDED` reports `missing_edges`, each tagged
  `edge_missing` | `event_missing` | `dangling_cause`.

Exactness: when both logs share the same event universe, reachability
inclusion is decided by SCC-partition agreement plus reduction-edge checks
(provably equivalent to closure inclusion). When universes differ,
reachability may flow through events the other log never recorded, so an
exact pairwise scan over shared events is used.

## Library

```js
import { createStore, ingest, merge, equiv, explain, snapshot, restore } from './src/index.js';

const store = createStore();
ingest(store, 'shiftA', [{ id: 'e1', causes: [] }, { id: 'e2', causes: ['e1'] }]);
ingest(store, 'shiftB', [{ id: 'e2', causes: ['e1'] }, { id: 'e1', causes: [] }]);
equiv(store, 'shiftA', 'shiftB');   // { status: 'EQUAL' }
explain(store, 'shiftA', 'shiftB'); // full diagnostics incl. canonical DAGs
merge(store, 'shiftA', 'shiftB', 'merged');
const text = snapshot(store);       // checksummed canonical JSON string
const r = restore('file.snap');     // { status: 'OK', store } | { status: 'RESTORE_CORRUPT' }
```

`restore` is pure: a corrupt snapshot never touches any existing in-memory
store. Snapshots carry a SHA-256 checksum over the canonical serialization;
truncation and bit flips are detected.

## CLI

```
node src/cli.js ingest   <store> <log_id> <events.jsonl>
node src/cli.js merge    <store> <a> <b> [new_id]
node src/cli.js equiv    <store> <a> <b>
node src/cli.js explain  <store> <a> <b>
node src/cli.js snapshot <store> <out>
node src/cli.js restore  <file>
```

The store file is itself a snapshot (created on first `ingest`, rewritten
atomically). JSONL input: one event per line, `{"id": "e1", "causes": ["e0"]}`.
Exit codes: `0` = OK/EQUAL/NOT_EQUAL/UNDECIDED, `1` = INVALID_INPUT/RESTORE_CORRUPT, `2` = usage.

## Tests

```
node --test
```

Covers: reorder-equivalence, missing-edge vs conflict rules, cycle
compression, random posets (n <= 9) cross-checked against a brute-force
transitive-closure reference, truncated/tampered snapshots, duplicate
`log_id`, empty-log boundaries, and a 3000-event scale test.

See `RESULTS.md` for the actual run.
