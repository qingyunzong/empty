# food-trace

Offline batch lineage tracing and recall certificates for a food/chemical
plant. Node.js 22, standard library only, tests use `node:test`.

## Event log (JSONL)

One JSON object per line, appended in order:

| type      | fields                                        | meaning                          |
|-----------|-----------------------------------------------|----------------------------------|
| `intake`  | `batch`                                       | raw material intake              |
| `mix`     | `output`, `inputs[]`                          | merge batches (causal edges)     |
| `split`   | `input`, `outputs[]`                          | divide a batch (causal edges)    |
| `inspect` | `id`, `batch`, `test`, `status`               | attach an inspection to a batch  |
| `correct` | `inspection`, `status`, `reason?`             | compensation node; history kept  |
| `scrap`   | `batch`, `reason?`                            | tombstone a batch                |

## Rules (rules_version `1.0.0`)

- A batch is contaminated when its own effective inspection is `fail`, or a
  parent is contaminated and that parent is not tombstoned.
- A correction never deletes the original inspection; it appends a
  compensation node and the contamination closure is recomputed
  incrementally (only the downstream closure of the inspected batch).
- A scrap tombstone blocks propagation to descendants (including splits
  registered later) but never erases the verdict of the scrapped batch or
  its upstream evidence.
- Any inspection status other than `pass`/`fail` is recorded as `unknown`
  and is never treated as a failure.
- Earliest contamination sources are reported lexicographically by batch id.

## CLI

```sh
node src/cli.js build   --input events.jsonl --state state.json
node src/cli.js correct --state state.json --inspection IN-1 --status fail --reason "lab retest"
node src/cli.js recall  --state state.json --out cert.json
node src/cli.js verify  --state state.json --cert cert.json   # or --input events.jsonl
```

The recall certificate contains `rules_version`, `input_hash` (sha256 over
the canonical event log), `sources`, `affected_batches`,
`affected_products` (contaminated sinks), `boundary` (frontier where
contamination stops: `sink` / `tombstone` / `clean-descendants`),
`corrections` and `tombstones`. `verify` replays the event log, recomputes
the certificate and compares every field.

Exit codes: `0` ok · `1` usage/IO error · `2` certificate mismatch ·
`6` cycle detected · `7` dangling batch/inspection reference.

## Tests

```sh
node --test
```

- `test/random.test.js` — 300 random small DAGs cross-checked against an
  independent DFS enumeration (contamination, sources, boundary).
- `test/correct.test.js` — one correction only mutates the downstream
  closure; incremental result equals full recompute.
- `test/scrap.test.js` — tombstones block later splits without erasing
  upstream evidence.
- `test/verify.test.js` — certificate round trip via real CLI subprocesses;
  tampered or stale certificates are rejected.
- `test/errors.test.js` — exit codes 6/7 and unknown-status handling.
