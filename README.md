# qcs — offline quality-inspection station ledger

Node.js 22, standard library only (`node:test` for tests). No dependencies.

Quality stations report measurements for `(lotId, testCode)`; later reports
re-measure or correct earlier records. The latest valid measurement per
`(lotId, testCode)` determines the judgment: `OK` / `NG` / `NCR`.

## Layout

- `src/store.js` — `QualityStore`: ingest, dedup, correction, judgment, index, recovery
- `src/wal.js` — write-ahead log: data line + commit marker, two fsync points
- `src/certs.js` — SHA256 chained certificates (self-contained, independently verifiable)
- `src/catalog.js` — test-item catalog (spec limits, plausible range, NCR thresholds)
- `src/reference.js` — naive oracle: replay valid committed records by sequence number
- `src/cli.js` / `bin/qcs.js` — JSON-in/JSON-out CLI

## Storage model

A database directory holds:

- `wal.log` — JSON Lines. Each record is a `{"k":"d",...}` data line followed
  by a `{"k":"c",...}` commit marker. Data is fsync'ed before the commit
  marker is written and fsync'ed again after (crash points `after-data-sync`
  and `after-commit-sync`). A data line without its commit marker is
  uncommitted and never produces a judgment; recovery truncates such tails.
- `state.json` — incremental state snapshot (atomic tmp+rename+fsync):
  `byClientId` (idempotency), `byKey` (the `(lotId,testCode)` secondary
  index), `records`, `lastSeq`, `lastHash`. Recovery = snapshot + replay of
  committed WAL entries with `seq > snapshot.lastSeq`, verified to match the
  naive full-replay oracle.
- `certs/<recordId>.json` — one certificate per committed record. Each
  certificate carries `prevHash`/`hash` (SHA256 over canonical record
  fields), forming a chain; old certificates remain valid after corrections.
- `catalog.json` — test items: `specLower/specUpper` (OK band), `absMin/absMax`
  (plausible range; outside → `ERR_VALUE_OUT_OF_RANGE`), optional
  `ncrBelow/ncrAbove` (outside → `NCR`, otherwise out-of-spec → `NG`).

## Semantics

- Every record carries a client-supplied `clientRecordId`. Re-reporting the
  same `clientRecordId` with the same payload is a no-op (no new state, no
  new certificate); a different payload → `ERR_CLIENT_ID_CONFLICT`.
- A correction must reference the `recordId` it corrects
  (`ERR_UNKNOWN_REFERENCE` if unknown, `ERR_ALREADY_CORRECTED` if already
  superseded). The corrected record is invalidated; the correction becomes
  the new head of its `(lotId, testCode)` index entry.
- Errors: business errors exit 1 (`ERR_VALUE_OUT_OF_RANGE`,
  `ERR_UNKNOWN_TEST`, `ERR_MISSING_FIELD`, `ERR_UNKNOWN_REFERENCE`,
  `ERR_ALREADY_CORRECTED`, `ERR_CLIENT_ID_CONFLICT`, `ERR_NOT_INITIALIZED`,
  `ERR_USAGE`); corruption exits 2 (`ERR_CORRUPT`); injected crash exits 3.

## CLI

```sh
node bin/qcs.js init --db ./db
node bin/qcs.js report --db ./db --json '{"clientRecordId":"c1","lotId":"L1","testCode":"DIM_LEN","value":10.0}'
node bin/qcs.js correct --db ./db --json '{"clientRecordId":"c2","correctsRecordId":"rec_...","value":10.4}'
node bin/qcs.js status  --db ./db --lot L1 --test DIM_LEN
node bin/qcs.js history --db ./db --lot L1 --test DIM_LEN
node bin/qcs.js verify  --db ./db [--record rec_...]
node bin/qcs.js recover --db ./db
```

`report`/`correct` also accept `--file FILE` or JSON on stdin. Success prints
JSON state on stdout (exit 0); errors print JSON on stderr.

Fault injection for testing: `QCS_FAULT=after-data-sync|after-commit-sync`.

## Tests

```sh
node --test
```

See `RESULTS.md` for the recorded run.
