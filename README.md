# Food Lot Traceability

Offline, single-machine traceability from finished products back to raw
material lots, using only the Node.js 22 standard library.

## Usage

```sh
node cli.js trace --in <input-dir> --out <output-dir>
node --test
```

## Input files (in `--in` dir)

- `lots.json` — array of `{ "id": "L1", "window": { "start": "...", "end": "..." } }`.
  `window` is the production window (ISO timestamps). Lots with no outgoing
  edges are finished products.
- `edges.jsonl` — one per line: `{ "id": "E1", "from": "R1", "to": "L1",
  "valid_from": "...", "valid_to": "..." }`. `from` is the upstream
  (consumed) lot, `to` the downstream (produced) lot. Supports merge and
  split. A failure propagates along an edge only when the edge's valid-time
  interval covers the downstream lot's production window.
- `tests.jsonl` — `{ "id": "T1", "lot": "R1", "result": "pass" | "fail" }`.
- `corrections.jsonl` — applied in order, incrementally:
  - `{ "type": "revoke_test", "test_id": "T1" }`
  - `{ "type": "update_edge", "edge_id": "E1", "valid_from": "...", "valid_to": "..." }`

## Status semantics

- A lot is `FAIL` if it (or anything upstream via a covering edge) has an
  active failing test.
- A lot is `UNKNOWN` when evidence is missing (no tests). `UNKNOWN` is never
  treated as `FAIL`.
- Otherwise `PASS`.

## Output files (in `--out` dir)

- `trace.json` — `{ "products": [ { "lot", "status", "certificate_hash" } ] }`.
- `certificates.jsonl` — append-only certificate log. When a correction
  changes a product, its old certificate is marked `"revoked": true` with
  `"superseded_by"` pointing at the new hash, forming a revocation chain.
- `errors.jsonl` — written instead (exit code 2) when validation fails:
  cycles (`CYCLE`), references to nonexistent lots (`UNKNOWN_LOT`),
  corrections targeting nonexistent tests/edges (`UNKNOWN_TEST` /
  `UNKNOWN_EDGE`), duplicate ids. No partial certificates are produced.

## Incremental recomputation

Corrections only dirty the downstream cone of their target (the tested lot
or the edge's consumer). Statuses and certificate hashes for that cone are
recomputed in topological order against cached upstream values; a new
certificate is issued only when a product's hash actually changes.
`test/acceptance.test.js` cross-checks this against an independent recursive
full recomputation on random DAGs.
