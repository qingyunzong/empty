# coldchain-cert

Offline compliance certificates for vaccine cold storage. Node.js 22,
standard library only, tests with `node:test`. No network, no dependencies.

## Usage

```sh
node cli.js certify --in <input-dir> --out <certs-dir>
node cli.js verify --out <certs-dir>
node --test
```

`certify` reads three files from the input dir and writes `*.json`
certificates plus `index.json` into the output dir:

| file              | format | required |
| ----------------- | ------ | -------- |
| `readings.jsonl`  | `{"sensor_id":"S1","ts":"2026-04-01T08:00:00Z","temp_c":3.1}` per line | yes |
| `shipments.json`  | `{"shipments":[{...}]}` (bare array also accepted) | yes |
| `adjustments.jsonl` | `{"sensor_id":"S1","start":"...","end":"...","offset_c":-1.2}` per line | no (empty if absent) |

Shipment fields: `batch_id`, `sensor_id`, `in_time`, `out_time`, and optional
`min_temp_c` (default 2), `max_temp_c` (default 8), `max_gap_seconds`
(default 300).

## Core mechanics

1. **Segments** — each shipment window `[in_time, out_time]` is split at the
   sensor's reading timestamps; a reading's temperature holds until the next
   reading. Any segment longer than `max_gap_seconds` is classified
   `UNKNOWN` and is never counted as an excursion (`gap == max_gap` is still
   evaluated). Status: `NON_COMPLIANT` if any excursion seconds, else
   `UNKNOWN` if any unknown seconds, else `COMPLIANT`.
2. **Adjustments** — `offset_c` is added to readings of `sensor_id` whose
   timestamp falls inside `[start, end]` (inclusive). Calibration always
   starts from the raw readings, which are never mutated (`raw_temp_c` is
   kept on every calibrated reading), and identical adjustment events are
   deduplicated, so replaying the same `adjustments.jsonl` is idempotent.
3. **Certificates & revocation** — a certificate's hash is
   `sha256` over the canonical JSON of `{batch_id, seq, prev_hash, payload}`;
   the `revoked` flag lives outside the hashed content. When a re-run
   produces different content (e.g. new adjustments arrived), the old
   certificate is marked `revoked` and a new one is issued with
   `prev_hash` linking the chain. Identical inputs reissue nothing and the
   hash is unchanged. `node cli.js verify --out <dir>` recomputes every
   hash and checks `seq` contiguity, `prev_hash` links, and that only the
   chain head is unrevoked.

## Exit codes

- `0` — success
- `1` — usage or unexpected error
- `2` — input error: inverted times (`E_TIME_INVERSION`), adjustment for an
  unknown sensor (`E_UNKNOWN_SENSOR`), missing/unparseable input
  (`E_MISSING_INPUT`, `E_PARSE`)

## Layout

- `cli.js` — CLI entry (`certify`, `verify`)
- `lib/load.js` — input parsing and validation
- `lib/calibrate.js` — adjustment replay (idempotent, raw-preserving)
- `lib/segments.js` — window segmentation and excursion accounting
- `lib/certs.js` / `lib/certify.js` / `lib/verify.js` — hash chain, issuance, verification
- `test/` — `node:test` suites, including the four acceptance criteria in
  `test/acceptance.test.js`
