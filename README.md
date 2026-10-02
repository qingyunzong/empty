# provq — query execution with lineage proofs

Node.js 22, standard library only. Executes select / join / semi-join / group-by
queries over JSON tables and, for every output row, captures a lineage proof:
which input rows contributed, the minimal contribution set, and any partial
(unknown-predicate) provenance. After input corrections, outputs can be
re-verified incrementally and receive affected / unaffected certificates.

## Data

`<dataDir>/<table>.json` holds either an array of row objects or
`{"key": "id", "rows": [...]}`. Every row needs a unique, non-NULL key
(default column `id`, overridable per table via `query.tables.<name>.key`).

## Query format (query.json)

```json
{
  "from": "emp",
  "joins": [
    { "table": "dept", "on": [["emp.dept", "dept.id"]] },
    { "table": "mgr",  "type": "semi", "on": [["emp.mgr", "mgr.id"]] }
  ],
  "where": [{ "col": "emp.age", "op": ">", "value": 30 }],
  "groupBy": ["emp.dept"],
  "aggregates": [{ "fn": "sum", "col": "emp.sal", "as": "total" }],
  "select": ["emp.name", "dept.dname"]
}
```

- Joins are inner by default; `"type": "semi"` keeps each left row once and
  records every matching right row as a witness.
- NULL join keys never connect (NULL ≠ NULL).
- WHERE uses three-valued logic. An unknown (NULL) predicate never drops the
  row and is never treated as false: the row is kept and its provenance is
  marked `partial` with the offending predicate and input rows listed.
- Aggregates: `count`, `sum`, `avg`, `min`, `max`. The contribution set of an
  aggregate output is the full set of input rows in the group. For `min`/`max`
  the minimal contribution set lists **all** tied rows; for semi-joins all
  witnesses are listed.

## CLI

```
provq exec <query.json> <dataDir>   execute, capture lineage, write proofs
provq prove <outKey>                verify + show one output row's proof
provq correct <table> <key> <patch> JSON-merge-patch one input row
provq reverify <outKey> | --all     incremental re-verify, emit certificate
provq explain [outKey]              lineage detail / state summary
```

State lives in `./.prov` (override with `--state <dir>` or `PROV_STATE`).

## Semantics

- `exec` writes, per output row, an output record and a proof file containing
  the row, its provenance, per-input digests, the data generation, and a
  SHA-256 digest over the canonical serialization. Changing one byte of a
  proof file fails verification with `E_PROOF`.
- `correct` patches one input row, bumps the data generation, and reports the
  affected outputs by intersecting the corrected row id with the output→input
  index. Inputs that never joined are in no contribution set, so nothing is
  marked affected.
- After any correction, older proofs are stale: `prove` fails with
  `E_STALE_PROOF` until `reverify` re-derives that output row from current
  data and issues an `affected` / `unaffected` certificate (refreshing the
  proof). Only the requested output is re-verified.
- Partial provenance is always reported explicitly (in `exec` output, proofs,
  and certificates). `reverify --all` refuses to issue a blanket certificate
  while any output is partial, failing with `E_PARTIAL_HIDDEN`.

## Errors

| Code               | Raised when                                                        |
| ------------------ | ----------------------------------------------------------------- |
| `E_KEY`            | missing/duplicate/NULL key, unknown table, key, or output key     |
| `E_PROOF`          | proof/state file missing, corrupt, or digest mismatch             |
| `E_PARTIAL_HIDDEN` | a blanket certificate would hide partial provenance               |
| `E_STALE_PROOF`    | proof predates the current data generation or query               |

## Tests

```
node --test
```
