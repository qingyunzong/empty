# weather-merge

Offline merge of multi-station weather temperature corrections. Stations
export correction streams as JSONL; this tool merges them in any order into a
single, canonical temperature-correction field. Node.js 22, standard library
only.

## Commands

```
node src/cli.js ingest <store> <file...>     validate & add JSONL records (- = stdin)
node src/cli.js merge  <out> <file...>       permissive union of JSONL stores into <out>
node src/cli.js query  <store> [--site S] [--from T] [--to T] [--include-invalid]
node src/cli.js compact <store> [--out F]    drop superseded records covered by min frontier vector
```

## Data model (JSONL, one record per line)

```json
{"type":"site","site":"S1","op":"register","origin":"O1","seq":1}
{"type":"site","site":"S1","op":"delete","origin":"O1","seq":9}
{"type":"correction","site":"S1","time":"2026-01-01T00:00:00Z","delta":-2.5,"origin":"O1","seq":2}
{"type":"frontier","origin":"O2","vector":{"O1":5,"O2":3}}
```

- Key = `(site, time)`; every value carries `(vector, origin, seq)`. `vector`
  defaults to `{origin: seq}` when omitted.
- Corrections (`delta`, °C) may be negative. `|delta| > 20` is **out of
  range**: the record is stored flagged `invalid: true` (evidence retained),
  hidden from default queries, visible with `--include-invalid`.
- Deleting a site writes a **tombstone** (`op:"delete"`). Tombstones win by
  the same total order and block resurrection: corrections of a deleted site
  are rejected at ingest (`TOMBSTONE_HIT`) and hidden from default queries
  even when stale replicas are merged later.

## Merge semantics

Winner per key = maximum under a total order:
`(sum(vector), origin, seq, canonical JSON)`. Because the order is total and
deterministic, merge is **commutative, associative and idempotent** — any
ingest/merge order and any duplication converge to the same canonical store
(verified for all permutations of ≤ 8 sites in `test/merge-laws.test.js`).

- `ingest` is a validating, atomic batch: records are merged tentatively, then
  every correction is checked against the resulting state (registration order
  inside a batch does not matter; a tombstone in the batch applies to the
  whole batch). On error the store file is left untouched.
- `merge` is a permissive CRDT union of stores/files.

## Compact

`compact` drops superseded loser records per key, but **only** for keys whose
winning vector is covered by the minimum frontier vector (component-wise min
across all `frontier` records, i.e. what every replica has seen). Without
frontier coverage nothing is dropped. Tombstones and frontier records are
always kept. Visible query results are identical before and after compact.

## Errors

| code           | exit | raised when                                                        |
|----------------|------|-------------------------------------------------------------------|
| `BAD_RANGE`    | 2    | non-finite `delta`, invalid timestamp, `--from` after `--to`, malformed record |
| `UNKNOWN_SITE` | 3    | correction or delete for a site that was never registered          |
| `TOMBSTONE_HIT`| 4    | correction ingested for a site whose tombstone wins                |

## Tests

```
node --test
```
