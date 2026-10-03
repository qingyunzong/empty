# mrp-net-requirements

Offline, single-machine net-requirement accounting for discrete manufacturing
work orders. Node.js 22, standard library only, tests via `node:test`.

## Model

- `work_order`: `{id, product, qty}`
- `bom`: `{parent, component, usage}`
- `inventory`: `{component, qty}` — `qty: null` means *unknown* stock

Gross requirements come from a relational-algebra fixpoint join of demand with
the BOM (max 20 levels), aggregated per component, then left-joined with
inventory. Unknown stock yields `net: null` (never coerced to 0); known stock
nets to `max(0, gross - onHand)`. An independent reference algorithm
(`referenceGross`) enumerates every BOM path of at most 20 edges and
recomputes gross demand for cross-checking.

## Event sourcing

`apply` persists each transaction to an append-only `log.jsonl` (with undo
info for corrections) and then rewrites `snapshot.json`. `correct`/`delete`
address records by key and fail on unknown keys. `query` reports the version,
per-component positive/negative deltas against the previous version, and a
sha256 certificate over the input log. Crash injection:

- `--fail before_append`: nothing is persisted
- `--fail after_append`: log entry durable, snapshot missing; the next
  `query`/`apply` recovers by replaying the log tail

## CLI

```
node src/cli.js apply <events.json> [--fail before_append|after_append] [--data DIR]
node src/cli.js query [--data DIR]
node src/cli.js paths [--data DIR]
```

Success prints JSON and exits 0; any error prints `{"error":"..."}` and exits 1.

## Verification

```
bash scripts/run-scenarios.sh   # writes result.txt: node --test + 3 CLI scenarios
```
