# greenhouse-flux-windows

Event-time hopping-window aggregation of greenhouse flux samples with
versioned calibrations. Node.js 22, standard library only, tests via
`node:test`.

## Usage

```sh
node src/cli.js flux --in events.jsonl   # or --in - for stdin
node --test                              # run the test suite
```

The CLI reads newline-delimited JSON events and prints one JSON record per
output line on stdout (`ADD`, `WITHDRAW`, or `ERROR`).

## Input events

```json
{"type":"FLUX","op":"UPSERT","id":"s1","sensorId":"gh-1","ts":"2026-01-01T00:02:00Z","value":12.5}
{"type":"FLUX","op":"RETRACT","id":"s1"}
{"type":"CALIBRATION","op":"UPSERT","id":"c1","sensorId":"gh-1","version":2,"effectiveFrom":"2026-01-01T00:00:00Z","expireAt":"2026-01-01T00:10:00Z","factor":1.1,"offset":0}
{"type":"CALIBRATION","op":"RETRACT","id":"c1"}
```

- Timestamps accept ISO-8601 strings or epoch milliseconds.
- `factor`/`offset` default to `1`/`0`; calibrated flux is
  `value * factor + offset`.
- UPSERT with an existing id replaces the previous record.

## Semantics

- **Windows**: hopping panes of 15 minutes sliding every 5 minutes, aligned
  to the epoch, per `sensorId`. A sample contributes to up to three panes.
- **Calibration resolution**: a calibration covers `[effectiveFrom,
  expireAt)`. Overlapping intervals resolve to the highest `version`;
  retracting a calibration restores the next-highest version (or the
  uncalibrated state). Samples without any active calibration keep their raw
  value and flag the pane `uncalibrated`.
- **Weighted flux**: within a pane, samples are segmented by their Voronoi
  time boundaries (clipped to the pane) and by calibration intervals; the
  pane value is the brute-force time-weighted mean of calibrated sample
  values, rounded to 6 decimals.
- **Watermark & freeze**: the watermark tracks the maximum FLUX event time
  seen. A pane freezes once the watermark exceeds `windowEnd + 1 minute`.
  A record whose target panes are all frozen is rejected with `LATE`;
  otherwise it is applied to the still-open panes.
- **Corrections**: any mutation that changes a pane result re-emits it as
  `WITHDRAW` (previous result) followed by `ADD` (new result).

## Output records

```json
{"type":"ADD","pane":"gh-1@2026-01-01T00:00:00.000Z/2026-01-01T00:15:00.000Z","sensorId":"gh-1","windowStart":"...","windowEnd":"...","weightedFlux":15.333333,"uncalibrated":false,"segments":[{"from":"...","to":"...","version":1}],"evidence":["s1","s2"]}
{"type":"WITHDRAW","pane":"...","weightedFlux":20,"segments":[...],"evidence":[...]}
{"type":"ERROR","code":"LATE","message":"record targets a frozen pane","id":"s9"}
```

Error codes: `MALFORMED` (bad shape, non-finite value/factor/offset, weight
sum anomaly), `INVALID_RANGE` (`effectiveFrom >= expireAt`),
`UNKNOWN_RETRACT` (retract of an unknown id), `LATE` (all target panes
frozen).

## Layout

- `src/engine.js` — window assignment, watermark/freeze, upsert/retract, recompute
- `src/pane.js` — brute-force weighted mean, calibration resolution, version segments
- `src/validate.js` — event validation and error codes
- `src/cli.js` — `flux --in <events.jsonl>` entry point
- `test/` — `node --test` suite and CLI fixture
