# coldchain-cert

Offline cold-chain vaccine compliance certificates. Node.js 22, standard
library only, no network access required.

## Usage

```sh
node cli.js certify --in <inputDir> --out <certsDir>
node cli.js verify --certs <certsDir> [--cert <file>]
node --test
```

`certify` reads three files from the input directory and (re)issues one
certificate per batch into the certs directory, plus an `index.json`
tracking every chain.

## Input formats

`readings.jsonl` — one JSON object per line:

```json
{"sensor_id":"s1","ts":"2026-01-10T08:00:00Z","temp_c":4.2}
```

`shipments.json` — JSON array:

```json
[{"shipment_id":"sh-001","batch_id":"batch-001","sensor_id":"s1",
  "in_ts":"2026-01-10T08:00:00Z","out_ts":"2026-01-10T12:00:00Z",
  "min_c":2,"max_c":8,"max_gap_s":3600}]
```

`adjustments.jsonl` — one JSON object per line (file may be empty/absent):

```json
{"sensor_id":"s1","start_ts":"2026-01-10T08:00:00Z","end_ts":"2026-01-10T12:00:00Z","offset_c":-1.5}
```

Timestamps accept ISO 8601 strings or epoch seconds.

## Semantics

- **Segments**: each shipment window `[in_ts, out_ts]` is evaluated against
  its sensor's readings. Temperature is a step function — a reading holds
  until the next reading. Any interval wider than `max_gap_s` is `UNKNOWN`
  and never counts as an excursion. A gap of exactly `max_gap_s` is still
  covered. Verdict: `UNKNOWN` if any unknown seconds, else `EXCURSION` if
  any out-of-range seconds, else `COMPLIANT`.
- **Adjustments**: `offset_c` is added to readings inside `[start_ts,
  end_ts]` only. Raw readings are never mutated; identical adjustments are
  deduplicated, so replaying the same adjustments file is a no-op and
  certificate hashes stay stable.
- **Certificate chain**: a cert's hash covers its full content
  (`sha256` of canonical JSON), including `prev_hash` and the digest of the
  adjustments applied to its sensor. When a re-run produces different
  content (e.g. a new adjustment), the old head is marked `revoked` in
  `index.json` and the new cert links to it via `prev_hash`. Identical
  re-runs change nothing. `verify` recomputes every hash, checks the
  linkage, and confirms only the chain head is active — a revoked cert is
  reported unusable.

## Errors (exit code 2)

- Time inversion: shipment `out_ts < in_ts`, or adjustment `end_ts < start_ts`.
- Adjustment referencing a sensor unknown to readings and shipments.
- Malformed input files or fields.

Other unexpected failures exit 1. `verify` exits 1 when the chain is
invalid or the named certificate is not usable.
