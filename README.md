# agv-deadlock

Offline deadlock detector for AGV (automated guided vehicle) intersection
traffic. Node.js 22, standard library only, no dependencies. Reads a JSONL
event stream, builds event-time occupancy windows, derives a wait-for graph,
and emits reproducible deadlock certificates (waiting directed cycles with
per-edge evidence events).

## Input format (JSONL, one event per line)

```json
{"op":"reserve","eventTs":1000,"agv":"A","edge":"E1","id":"R1"}
{"op":"ping","eventTs":1100,"agv":"A","node":"N1","speed":0.4,"id":"P1"}
{"op":"cancel","eventTs":5000,"reserveId":"R1"}
{"op":"retract","eventTs":6000,"kind":"ping","id":"P1"}
```

- `reserve`: an AGV requests/occupies `edge` during the half-open window
  `[eventTs, eventTs + windowMs)` (default `windowMs = 10000`).
- `ping`: heartbeat; a reserve is **real occupancy** only if a ping from the
  same AGV falls inside its window (window join).
- `cancel`: removes the reserve with the given `reserveId`.
- `retract`: removes a previous `ping` or `reserve` by `kind` + `id`.

## Semantics

- **Event time, not arrival order.** Concurrency is decided purely by
  event-time interval overlap. Events are still applied in arrival order so
  that late cancels/retracts can rewrite history.
- **Half-open intervals.** Two windows that touch exactly at an endpoint
  (`[0,10)` vs `[10,20)`) do **not** overlap and create no wait edge.
- **Wait edge.** AGV X waits for AGV Y when X's reserve and Y's
  ping-confirmed reserve share an edge with a positive-length overlap. The
  reserve that is later in `(eventTs, agv, id)` order is the waiter.
- **Watermark.** `watermark = max(eventTs seen so far) - 2000ms`. Events
  below the watermark are logged to `late.log` but still processed — a late
  cancel can dissolve a previously detected deadlock.
- **Deadlock certificate.** Each elementary directed cycle in the wait-for
  graph, canonicalized (rotated to the lexicographically smallest AGV) with
  the evidence event ids of every edge. `hash = sha256` of the canonical
  JSON, so identical inputs always reproduce identical certificates.
- **Invalidation.** When a cancel/retract breaks a previously active cycle,
  an `invalidated` record is appended to `invalid.jsonl` preserving the
  original certificate hash.

## CLI

```
agv deadlock --in <dir> --out <dir> [--window-ms N] [--watermark-ms N]
```

Reads every `*.jsonl` file in `--in` (sorted by name) and writes to `--out`:

- `cycles.json` — currently active deadlock certificates
- `waits.jsonl` — current wait-for edges with evidence (one JSON per line)
- `invalid.jsonl` — invalidated certificates, original hashes kept
- `late.log` — events that arrived below the watermark

Exit codes: `0` success (deadlocks are findings, not errors), `1` data error
(`UNKNOWN_AGV`, `DUP_RESERVE`, `BAD_JSON`, `INVALID_EVENT`), `2` usage/IO
error.

## Library

```js
import { runEngine } from './src/engine.js';
const { waits, cycles, invalidated, late } = runEngine(events, { windowMs: 10000 });
```

## Tests

```
node --test
```
