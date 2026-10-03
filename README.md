# boiler-interlock-replay

Offline replayer that proves (or disproves) that a boiler shutdown was caused
by the pressure+temperature interlock combination rather than sensor jitter.
Node.js 22, standard library only, tests via `node:test`.

## Usage

```
interlock replay --in <dir> --out <dir> [options]
# or: node bin/interlock.js replay --in <dir> --out <dir>
```

Input: all `*.jsonl` files in `--in` (processed in arrival order = file name
order, then line order), one event per line:

```
{"type":"sensor","id":"s1","eventTs":0,"tag":"pressure","value":1200,"unit":"kPa","seq":0}
{"type":"sensor","id":"s2","eventTs":0,"tag":"temperature","value":200,"unit":"C","seq":0}
{"type":"trip","id":"tr1","eventTs":4000,"channel":"PT-1","state":"TRIPPED"}
{"type":"retract","eventTs":7000,"kind":"sensor","id":"s1"}
```

Outputs in `--out`:

- `states.jsonl` — emitted interlock transitions, one per line. `op:"EMIT"`
  for new states, `op:"REVOKE"` for reverse compensation when late data or
  retracts invalidate a previously emitted ARM/TRIP.
- `proof.json` — final verdict (`TRIP_CAUSED_BY_PT_COMBINATION` /
  `NO_PROVEN_TRIP`) with per-trip evidence (condition start, ARM time, held
  duration, contributing samples), diagnostics and counters.
- `late.log` — events that arrived behind the watermark and were inserted
  into history (`reason:"LATE_EVENT"`).
- `snapshot.json` — crash recovery point, rewritten atomically after every
  processed input line (every event-time batch boundary included).

## Semantics

- A sensor sample is valid on `[eventTs, eventTs + windowMs)` (default
  window 2000 ms). The join condition holds at instant *t* when the latest
  valid pressure sample and the latest valid temperature sample are both
  strictly above their limits (a value exactly equal to the limit does not
  count).
- Condition held continuously for `durationMs` (default 3000) raises `ARM`
  at `runStart + durationMs`; the condition breaking ends it with `DISARM`.
  A `trip` event while ARM yields a `TRIP` record linking the two.
- Watermark = max event time seen − `watermarkLagMs` (default 1000 ms).
  Transitions at or below the watermark are emittable; an event arriving
  with `eventTs < watermark` is late: it is logged, inserted into history,
  and the derivation is recomputed — revoking states that no longer hold
  and restoring alarms that had been suppressed. An event with
  `eventTs == watermark` is still on time.
- `retract` removes a sensor/trip from history and triggers the same
  recompute, so suppressed alarms reappear.
- Duplicate events (same `id`) are applied once and counted
  (`counts.duplicates`); retracts are idempotent via a deterministic id.
- A sensor event without `unit` is reported as `UNIT_MISSING` (stderr +
  `proof.json` diagnostics) and ignored; a wrong unit is `UNIT_MISMATCH`.

## Crash recovery

After every processed input line the engine fsyncs the outputs and
atomically rewrites `snapshot.json` (seen ids, pending batches, emitted
states, counters, output byte offsets). On restart the snapshot is
restored, the outputs are truncated to the recorded offsets (a crash may
land between the output flush and the snapshot write), and replay
continues at the recorded input line. Re-running a finished replay is a
no-op. The env var `INTERLOCK_EXIT_AFTER_COMMITS=<n>` aborts the process
after `n` commits to simulate a crash (test hook).

## Options

`--pressure-tag` (pressure), `--temp-tag` (temperature),
`--pressure-limit` (1000), `--temp-limit` (180), `--pressure-unit` (kPa),
`--temp-unit` (C), `--duration-ms` (3000), `--window-ms` (2000),
`--watermark-lag-ms` (1000).

## Tests

```
node --test
```

Covers: out-of-order revocation of a false TRIP, retract restoring a
suppressed ARM, watermark-boundary and exact-limit samples, exhaustive
2^6 × 2^6 pressure/temperature sequence enumeration against an independent
reference, idempotent duplicates, UNIT_MISSING, and kill/recovery
equivalence (test-hook abort and real SIGKILL).
