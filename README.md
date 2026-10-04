# Bitemporal Equipment-State Audit

Single-machine, offline audit of equipment state history. Library + CLI,
Node.js 22 standard library only, tested with `node:test`.

## Model

- Events are `{id, equipment, valid_time, state, tx_id, tx_time}` with
  `state in {up, down}`. `valid_time` is when the state was true in the real
  world; `tx_time` is when the transaction recorded it.
- The log is **append-only**: corrections are compensating events (same
  equipment/valid_time, later tx_time); old records are never overwritten.
- **AS OF queries**: state at a `valid_time` as of a `tx_time`. Views pinned
  to an old `tx_time` are immutable — later retroactive corrections never
  change them — while the current view reflects every committed correction.
- **Daily counts**: for each UTC day in the maintained range (earliest to
  latest visible event day), each equipment counts as up/down according to
  its state at end-of-day (latest event with `valid_time <=` end of day).
  Every commit/undo prints the signed per-day deltas it caused.
- **Undo**: `undo --tx <tx_id>` appends a compensating revert entry. The
  current snapshot and deltas are maintained (undo restores the exact prior
  snapshot hash); AS OF views between the original commit and the revert
  still see the transaction.
- **Atomic batches**: a batch is validated as a whole (schema + times).
  Any illegal event rejects the entire batch — no partial state, the log
  file is untouched, counts and hash are unchanged.
- **Crash recovery**: durability point is the single-line log append
  (JSONL + SHA-256 checksum per line). Crash after append → the next start
  replays the log and rebuilds state automatically. Crash before append →
  no effect. A torn final line fails parse/checksum and is ignored.
- **Reference algorithm**: `src/reference.js` independently scans all log
  entries and rebuilds the bitemporal intervals from scratch. `verify`
  cross-checks the incremental engine against it, and the test suite
  property-checks random commit/undo workloads against it.

## Usage

```sh
node cli.js append <log> --file batch.json
node cli.js undo <log> --tx <tx_id> [--tx-time ISO]
node cli.js state <log> --equipment E --valid-time ISO [--tx-time ISO]
node cli.js counts <log> [--tx-time ISO]
node cli.js hash <log>
node cli.js verify <log>
```

Batch file format:

```json
{"tx_id": "tx-1", "tx_time": "2024-01-10T00:00:00Z",
 "events": [{"id": "e1", "equipment": "pump-1",
             "valid_time": "2024-01-01T08:00:00Z", "state": "up"}]}
```

## Verification

```sh
node --test                 # unit + property tests
bash scripts/run-scenarios.sh   # regenerates result.txt with real CLI output
```

`result.txt` contains the captured real output of the three acceptance
scenarios: (1) retroactive valid_time correction, (2) out-of-order tx_time
visibility, (3) atomic rejection of an invalid batch.
