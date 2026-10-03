# night-qc

Incremental quality-control engine and CLI for astronomical night observations.
Node.js 22, standard library only, fully offline.

## Model

- Observation **frames** are grouped by `(night, instrument)`.
- A frame's quality depends on three dependency nodes: the **dark** and
  **flat** calibration of its `(night, instrument)` group, and the **weather**
  node of its night. Each night also has a **summary** node that depends on
  all of the night's frames.
- Derived flags are `usable`, `degraded`, `blocked`.

## Flag rules (exact boundary semantics)

A frame is:

1. `blocked` if its night weather is `blocked`, or the dark/flat calibration
   of its group is missing;
2. `degraded` if weather is `degraded`, or `noise > noiseThreshold`
   (strictly greater — equality stays `usable`), or a calibration quality is
   `< calibQualityThreshold` (strictly less — equality stays `usable`);
3. `usable` otherwise. A missing weather node defaults to `clear`.

Night summary counts flags per night; `nightFlag` is `blocked` when all
frames are blocked, `degraded` when any frame is not usable, else `usable`.
An empty night is stable: zero counts, `nightFlag: "usable"`.

## Incremental transactions

`QcEngine.applyTransaction({ id, budget, ops })` applies ops, propagates
invalidation along the dependency graph, and recomputes only affected frames
and night summaries. Supported ops: `addFrame`, `removeFrame`,
`upsertCalibration`, `removeCalibration`, `setWeather`, `regroupFrame`
(moves a frame to another `(night, instrument)` group, re-wiring its
dependencies and both night summaries).

Each transaction returns `{ ok, txnId, flagDiffs, recomputeQueue, certificate }`.
The recompute queue lists frames first (sorted by `(night, frameId)`), then
summaries (sorted by night). The certificate records the invalidated node
set, recomputed nodes, flag/summary diffs, budget usage, and a SHA-256
digest of the resulting flags and summaries.

If the number of nodes to recompute exceeds `budget`, the transaction
returns `E_BUDGET` and all state is rolled back. Invalid ops return
`E_INVALID` (or `E_NOT_FOUND`) and also roll back.

## CLI

```
node src/cli.js < req.json
```

Request: `{ "config": {...}, "state": {...}, "transactions": [...] }`.
Response: `{ "results": [...] }`, or `{ "error": { "code", "message" } }`
with exit code 1 for malformed requests. See `examples/req.json`.

## Reference oracle

`src/reference.js` implements the same semantics by full enumeration:
every transaction rebuilds the dependency relation and recomputes all flags
and summaries from scratch. `test/reference.test.js` cross-checks the
incremental engine against it over randomized scenarios (≤ 2 nights,
≤ 5 frames per night), comparing flags, summaries, recompute queues and
flag diffs, including budget-exceeded rollbacks.

## Tests

```
node --test
```
