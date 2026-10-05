# shiftlog-equiv

Offline shift-handover log merge & equivalence checker. Node.js 22 standard
library only, fully offline, single machine.

## Model

Each shift records a log of device state-transition events. An event has an
`id`, direct causal predecessors (`preds`), and an optional `state` payload.
The canonical form of a log is the reachability relation (transitive closure)
of its event partial order after SCC compression, plus per-event canonical
state and the boundary snapshot (source/sink components of the condensation
DAG). Event order inside a log file is irrelevant.

## Verdict rules (`equiv` / `explain`)

- `EQUAL` — identical recorded event sets, identical external references,
  identical states, identical closures on shared events.
- `NOT_EQUAL` — positive contradiction: a shared event carries a different
  state payload, or the two partial orders are incomparable (each orders some
  pair the other cannot derive, e.g. `x<y` in one and `y<x` in the other).
  Reports `first_divergent` and `minimal_frontier` (a shortest witness path of
  direct causal edges for the first divergent order pair).
- `UNDECIDED` — every difference is explainable by missing information (one
  side's closure is a subset of the other's, or events/external references are
  missing). Missing information is never reported as inconsistency. Reports
  `missing_edges`.
- `INVALID_INPUT` — malformed events, duplicate `log_id`, unknown logs, merge
  state conflicts.
- `RESTORE_CORRUPT` — snapshot failed integrity checks (magic, version,
  SHA-256 checksum, schema). In-memory state is left untouched.

## Library

```js
import { Store } from './src/store.js';

const s = new Store();
s.ingest('shift-1', [{ id: 'e1' }, { id: 'e2', preds: ['e1'], state: { v: 1 } }]);
s.ingest('shift-2', [{ id: 'e3', preds: ['e2'] }]);
s.merge('handover', ['shift-1', 'shift-2']);
s.equiv('shift-1', 'shift-2');   // { status: 'UNDECIDED', missing_edges: [...] }
s.explain('shift-1', 'shift-2'); // verdict + boundary snapshots of both logs
const text = s.snapshot();       // integrity-checked JSON snapshot
Store.restore(text);             // { status: 'OK', store } | { status: 'RESTORE_CORRUPT' }
```

## CLI

State lives in a store file (snapshot format). JSONL ingest: one event per line.

```sh
node cli.js ingest   <store> <log_id> <events.jsonl>
node cli.js merge    <store> <new_log_id> <log_id...>
node cli.js equiv    <store> <log_a> <log_b>
node cli.js explain  <store> <log_a> <log_b>
node cli.js snapshot <store> [outfile]
node cli.js restore  <store> <snapshot_file>
```

Exit codes: `OK`/`EQUAL`=0, `NOT_EQUAL`=1, `UNDECIDED`=2, `INVALID_INPUT`=3,
`RESTORE_CORRUPT`=4.

## Tests

```sh
node --test
```
