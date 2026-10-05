# buoy-profiles

Ocean buoy dive-profile processor. Node.js 22, standard library only.

## CLI

```sh
node src/cli.js profiles --in dives.jsonl
```

Reads newline-delimited JSON events, writes JSONL results to stdout.
Errors are written to stderr as JSON lines; the process exits with code 2
if any error occurred, 0 otherwise.

## Events

```json
{"type":"UPSERT","profileId":"p1","depth":100,"temp":15.2,"version":1,"time":"2026-10-05T00:00:00Z"}
{"type":"RETRACT","profileId":"p1","depth":100,"version":2,"time":"2026-10-05T00:01:00Z"}
{"type":"WATERMARK","time":"2026-10-05T01:00:00Z"}
```

- `time` accepts ISO 8601 strings or epoch milliseconds; event order may
  not match time order.
- `depth` must be a unique integer in [0, 1000] meters. A higher `version`
  for the same depth overwrites the lower one; a version that does not
  advance is rejected with `STALE_VERSION`.
- `RETRACT` of a depth with no live observation is rejected with
  `UNKNOWN_RETRACT`. Retraction recomputes only the adjacent depth pairs,
  so it can create or eliminate inversions and merges missing-depth blocks.

## Semantics

- **INVERSION**: an adjacent pair (sorted by depth) whose temperature rises
  by more than 0.5 °C with increasing depth.
- **Session close**: when a `WATERMARK` exceeds a profile's last observation
  time by more than 30 minutes, the profile closes and a `CERTIFICATE` is
  published with the sorted depth sequence, all inversion pairs, the maximal
  inversion layer (`maxInversion`), and missing-depth block statistics.
- Any `UPSERT`/`RETRACT` for a closed profile is rejected with `LATE`.

## Tests

```sh
node --test
```

`test/reference.js` is an independent brute-force oracle (sort, check every
adjacent pair, enumerate contiguous missing intervals) used by the property
test; it shares no code with `src/`.
