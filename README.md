# provdb — query execution with provenance proofs

Node.js 22, standard library only, tests with `node:test`. Single-machine, offline.

Every output row of a query carries a **proof** naming exactly which input rows
(and later corrections) produced it. After inputs are corrected, each output
can be re-verified incrementally and certified `affected` / `unaffected`.

## Layout

- `src/engine.js` — select / join / groupby execution with lineage capture
- `src/store.js` — data dir, state, epochs, corrections log, proof files
- `src/verify.js` — incremental re-verification and certificates
- `src/cli.js` — CLI (`runCli` is exported for in-process testing)
- `test/` — `node --test`

## Data and query format

`<dataDir>/<table>.json`: `{ "key": "<pk column>", "rows": [ ... ] }`.
Keys must be non-NULL and unique (`E_KEY`).

`query.json`:

```json
{
  "from": "a",
  "joins": [{ "type": "inner|semi", "table": "b", "on": [["a.k", "b.k"]] }],
  "where": [{ "col": "a.x", "op": ">=", "value": 5 }],
  "groupby": ["a.k"],
  "aggregates": [{ "fn": "sum|count|avg|min|max", "col": "b.amt", "as": "total" }],
  "select": ["a.k", "total"]
}
```

## Semantics

- **Joins**: hash join on equality pairs. NULL keys never join — not even
  NULL = NULL. `semi` joins deduplicate: the left row is kept once, and the
  deduplicated right-hand keys are recorded as lineage.
- **Three-valued predicates**: `false` rows are dropped; `unknown` rows (any
  comparison touching NULL) are **kept** and flagged `provenance: "partial"`.
  They are never silently dropped and never treated as unsatisfied. Partial
  provenance propagates through joins into aggregate groups and is reported
  explicitly in the `exec` summary, in proofs, and in certificates.
- **Aggregates**: each group output records the full contribution set
  (why-provenance) plus a minimal witness set. For `min`/`max`, ties are
  listed in full — every row tied at the extreme value is a witness.
- **Output keys**: `grp:<canonical group values>` for aggregates, content
  hash `row:<hash>` for plain selects.

## CLI

```
prov exec <query.json> <dataDir>   # run, capture lineage, write proofs
prov prove <outKey>                # print tamper-evident proof (verified on read)
prov correct <table> <key> <patch> # merge a JSON patch into one input row
prov reverify <outKey>             # affected/unaffected certificate
prov explain [outKey]              # plan + provenance summary [+ one row's lineage]
```

`exec` writes `<dataDir>/.prov/` (state, proofs, certs) and a `.prov-link`
in the cwd so later commands find the data dir (`--data` / `PROV_DATA_DIR`
override). Each proof file carries a SHA-256 digest over its canonical
content; changing one byte fails verification.

## Incremental re-verification

Outputs are indexed by outKey; inputs are indexed as `table key` → outKeys.
A correction (logged with its changed columns and a new data epoch) can only
affect an output if it changed a query-referenced column of a contributing
row, or a membership column (join/where/groupby) of any row. Otherwise the
certificate is `unaffected` via `incremental-index` without re-execution;
otherwise the query is re-executed and the row compared (`re-execution`).
Correcting an input that never joined therefore never marks an output
affected.

## Errors (exit codes)

| code | exit | meaning |
| --- | --- | --- |
| `E_KEY` | 2 | unknown table / key / outKey, duplicate or NULL primary key |
| `E_PROOF` | 3 | proof file missing, corrupted, or digest mismatch (tampered) |
| `E_PARTIAL_HIDDEN` | 4 | partial provenance would be hidden; pass `--allow-partial` |
| `E_STALE_PROOF` | 5 | data corrected since `exec`; re-run `exec` before `prove` |

## Tests

```
node --test
```

Covers: NULL join keys, semi-join dedup, unknown→partial (kept, not dropped),
a 150-row aggregate contribution set checked against full enumeration, tied
minimal witness sets, unaffected/affected certificates, one-byte proof
tampering, stale proofs, and explicit partial reporting.
