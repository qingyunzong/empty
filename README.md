# agv-deadlock

Offline deadlock detector for AGV intersection congestion. Reads a JSONL event
log, builds intersection occupancy windows in **event time**, joins pings with
reservations to derive a wait-for graph, and emits reproducible deadlock
certificates (directed wait cycles + per-edge evidence events). Node.js 22,
standard library only, no network access required.

## CLI

```
agv deadlock --in <dir> --out <dir> [--lag-ms <ms>]
# or: node bin/agv.js deadlock --in <dir> --out <dir>
```

Reads every `*.jsonl` file in `--in` (sorted by filename, then line order) and
writes into `--out`:

| file           | content                                                        |
| -------------- | -------------------------------------------------------------- |
| `cycles.json`  | JSON array of every emitted deadlock certificate (append-only) |
| `waits.jsonl`  | final wait-for edges, one JSON object per line                 |
| `invalid.jsonl`| invalidation records (`invalidated: true` + original cert hash)|
| `late.log`     | one line per late event (eventTs < watermark)                  |

Exit codes: `0` ok, `2` `DUP_RESERVE`, `3` `UNKNOWN_AGV`, `1` anything else.

## Input events (one JSON object per line)

```json
{"type":"reserve","id":"r1","eventTs":1000,"agv":"A","edge":"n1->n2","op":"start"}
{"type":"reserve","id":"r1","eventTs":5000,"agv":"A","edge":"n1->n2","op":"end"}
{"type":"ping","id":"p1","eventTs":2000,"agv":"B","node":"n1","speed":0,"op":"set"}
{"type":"cancel","eventTs":3000,"reserveId":"r1","op":"cancel"}
{"type":"retract","eventTs":4000,"kind":"reserve","id":"r1"}
{"type":"retract","eventTs":4000,"kind":"ping","id":"p1"}
```

- `eventTs` is event time in milliseconds. `edge` ids have the form
  `from->to`; the two endpoints are the nodes incident to the edge.
- `reserve` `start`/`end` ops with the same `id` pair up (in event-time order)
  into an occupancy window `[start, end)`. An unclosed `start` is open-ended.
- `ping` is valid from its `eventTs` until the same AGV's next ping
  (event-time order). `speed <= 0` means the AGV is stopped at `node`.
- `cancel` truncates the window of `reserveId` at the cancel's `eventTs`.
- `retract` deletes the referenced event(s) entirely (`kind`:
  `reserve` | `ping` | `cancel`).

## Semantics

- **Event time, not arrival order.** All window pairing, overlap tests and
  joins are computed from `eventTs` intervals; arrival (file) order only
  drives watermark/lateness bookkeeping and stream-constraint checks.
- **Watermark** = max event time seen − `lag-ms` (default 2000). Events with
  `eventTs < watermark` are logged to `late.log` but still applied, so a late
  cancel/retract can rewrite history and break a previously detected cycle.
- **Wait edge** `waiter -> blocker`: a stopped ping (`speed <= 0`) of AGV B at
  node N overlapping (strictly: `max(start) < min(end)`, touching endpoints do
  not count) a reserve window of AGV A on an edge incident to N means A waits
  for B. Evidence: `{reserveId, pingId}`.
- **Certificate**: a directed simple cycle of wait edges plus the maximal time
  interval during which all its edges hold simultaneously, plus per-edge
  evidence. `hash` = sha256 of the canonical JSON of `{cycle, interval,
  edges}`. Interval end `null` means open-ended.
- **Invalidation**: when a cancel/retract changes history so an emitted
  certificate no longer holds, a record `{hash, invalidated: true, ...}` is
  appended to `invalid.jsonl`; the original certificate stays in
  `cycles.json`.
- **Stream constraints** (checked in arrival order): the first event
  introducing an AGV must be a `reserve` (`ping` of an unknown AGV →
  `UNKNOWN_AGV`); a `reserve` `start` with a live duplicate `id` →
  `DUP_RESERVE` (ids may be reused after retraction).

## Development

```
node --test     # run all tests
```
