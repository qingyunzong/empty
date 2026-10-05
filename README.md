# greenhouse-flux

Greenhouse flux windowing engine. Node.js 22, standard library only, tests via `node:test`.

## Model

- Sensors submit `FLUX` samples and `CALIBRATION` records (JSONL, one event per line).
- Windows: 15 minute size, 5 minute slide. Pane id: `<sensorId>#<k>`, covering
  `[k*5min, k*5min + 15min)`.
- A calibration is active on `[effectiveFrom, expireAt)`. Overlapping ranges resolve to the
  highest `version`; retracting a calibration restores the next-highest version (or the
  uncalibrated state). Samples without any active calibration are marked `UNCALIBRATED`.
- Inside a pane, each sample gets a time weight from its Voronoi cell clipped to the window
  (weights sum to the window length). Weighted flux is the brute-force weighted mean of
  `value * factor` per sample, segmented by the calibration version in effect.
- `UPSERT` / `RETRACT` before the watermark closes a pane incrementally recompute every
  overlapping pane and emit `WITHDRAW` (previous result) plus `ADD` (new result).
- Watermark = max event time seen. Once the watermark passes `windowEnd + 1min`, the pane is
  frozen and later records for it are rejected as `LATE`.
- Errors: `UNKNOWN_RETRACT` (retracting an unknown id), `INVALID_RANGE`
  (`expireAt <= effectiveFrom`), `MALFORMED` (bad JSON / missing fields / weight-sum anomaly).

## Event format

```json
{"type":"FLUX","op":"UPSERT","id":"s1","sensorId":"gh-1","ts":120000,"value":10}
{"type":"CALIBRATION","op":"UPSERT","id":"c1","sensorId":"gh-1","version":2,"effectiveFrom":0,"expireAt":600000,"factor":1.1}
{"type":"FLUX","op":"RETRACT","id":"s1"}
{"type":"CALIBRATION","op":"RETRACT","id":"c1"}
```

## CLI

```sh
node src/cli.js flux --in events.jsonl   # use "-" for stdin
```

Emits one JSON object per line: `ADD` / `WITHDRAW` pane results (pane id, weighted flux,
calibration version segments, evidence member list) and `ERROR` records.

## Tests

```sh
node --test
```

Latest real run is captured in `test-results.txt`.
