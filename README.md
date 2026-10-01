# kvstore

Single-file log-structured key-value store with nested transactions
(max depth 3), fault injection, and crash recovery. Python 3.11+
standard library only.

## CLI

```
python -m kvstore run script.json [--inject faults.json] [--replay] [--db PATH]
```

- `script.json`: JSON list of steps. Ops: `begin`, `put` (`key`/`value`),
  `del` (`key`), `commit`, `rollback`, `view` (no-op, prints the view).
- `faults.json`: JSON list of fault-point names; each fires once.
- `--replay`: recover the existing log first (truncate a corrupt tail,
  replay committed transactions). Without it the log starts fresh.
- One JSON line per step is printed with the visible view after the step.
- Exit code `0` on success, `3` on failure (injected crash, `E_CORRUPT`,
  bad script/faults file). Step-level `E_TXN`/`E_IO` errors are reported
  in the step output and the run continues.

## Log format

Header `KVLOG001`, then records of `u32be len | JSON payload | u32be crc32`.
Only outermost commits reach the log: one record per write, then a
`commit` record, then `fsync`. Recovery applies only transactions closed
by a `commit` record.

## Fault points (one-shot each)

- `append_before`: fail before appending commit records -> `E_IO`, txn aborts.
- `append_after`: crash after data records, before the `commit` record;
  recovery discards the uncommitted tail.
- `fsync_fail`: commit fsync fails -> `E_IO`; the partial records are
  truncated so the whole transaction aborts with no partial visibility.
- `crash_after_commit`: crash after the commit is durable; the
  transaction is fully visible after restart.

## Semantics

- Inner `commit` merges the write-set into the parent; inner `rollback`
  discards only its own layer.
- Outermost `commit` is atomic: on `fsync_fail` the whole transaction
  aborts and previously committed values remain visible.
- Recovery truncates a corrupt tail record (short length/payload, CRC
  mismatch, bad JSON); committed records before it are preserved.
  A non-empty file with a bad header raises `E_CORRUPT`.
- Error codes: `E_TXN` (transaction misuse), `E_IO` (storage/injected
  I/O faults), `E_CORRUPT` (unrecoverable corruption).

## Tests

```
python -m unittest discover -s tests -v
```
