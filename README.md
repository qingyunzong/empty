# buoy-profiler

Ocean buoy profile sessionizer. Node.js 22, standard library only, tests via `node:test`.

## Usage

```sh
node src/cli.js profiles --in dives.jsonl
npm test   # node --test
```

Input is JSONL, one event per line:

```json
{"type":"UPSERT","profileId":"p1","depth":20,"temp":8.0,"version":1,"eventTime":"2026-10-04T06:00:00Z"}
{"type":"RETRACT","profileId":"p1","depth":20,"version":2,"eventTime":"2026-10-04T06:05:00Z"}
{"type":"WATERMARK","profileId":"p1","time":"2026-10-04T06:36:00Z"}
```

`eventTime`/`time` accept ISO 8601 strings or epoch milliseconds.

## Output

Results are JSONL on stdout; exit code is 0. Domain rejections are result records
(`{"type":"rejected","reason":...}`). Input/usage errors are JSON on stderr with exit code 2.

- `upsert` / `retract` (`status:"applied"`): current inversion pairs, max inversion layer,
  and (for retract) missing-depth stats.
- `certificate`: emitted when a watermark exceeds the profile's last observation time by
  30 minutes. Contains session start/end, sorted depth sequence, inversion pairs, the
  maximum inversion layer interval, and missing-depth block statistics.
- `rejected` reasons: `LATE` (profile already published), `STALE_VERSION` (version not
  greater than the stored one), `UNKNOWN_RETRACT` (no point at that depth),
  `INVALID_DEPTH` (non-integer or outside 0..1000 m).

## Rules

- A profile groups observations sharing `profileId`; events may arrive out of order in
  both depth and event time. The session ends 30 minutes after the last observation.
- Depths are unique integer meters in [0, 1000]. A higher `version` at the same depth
  overrides the stored point; anything else is `STALE_VERSION`.
- An adjacent pair (sorted by depth) is an INVERSION when temperature rises by more
  than 0.5 °C with depth. The maximum inversion layer is the longest run of adjacent
  inversion pairs (ties: wider depth span, then shallower start).
- Missing-depth blocks are contiguous integer-depth intervals with no observation,
  enumerated inside the profile's [min, max] observed depth range.
- Retracting a point incrementally recomputes only the adjacent depth pairs and merges
  or extends the neighboring missing blocks.

## Layout

- `src/profile.js` — incremental per-profile state (sorted depths, inversion pairs, missing blocks).
- `src/engine.js` — event application: versions, watermark/session close, certificates.
- `src/cli.js` — CLI (`run()` is exported for in-process testing).
- `test-reference/reference.js` — independent brute-force reference (sort, check all
  adjacent pairs, enumerate missing intervals) used by the differential test; shares no
  code with `src/`.
