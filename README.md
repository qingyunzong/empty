# settlement-ledger

Offline settlement ledger library + CLI. Node.js 22, standard library only.

- **MVCC**: every `pay` and `cancel` commits a new global version; balances are
  readable as-of any retained version (`get --at`).
- **WAL**: `wal.log` is append-only and never truncated; it is the source of truth.
- **Checkpoint**: writes committed accounts, the tx secondary index and the
  version watermark to `checkpoint.json.tmp`, fsyncs, then atomically renames
  to `checkpoint.json`. Version GC keeps the version visible to the oldest
  active snapshot plus everything newer — active snapshots always keep their
  as-of reads working across checkpoints.
- **Crash recovery**: a leftover tmp file (crash at C1 = mid-write, C2 = before
  rename) is never trusted; recovery deletes it and falls back to the old
  checkpoint plus WAL replay. `cancel` of a paid tx appends a reverse version.

## CLI

```
node cli.js [--dir DATA] pay --tx T --from A --to B --amount N
node cli.js [--dir DATA] cancel --tx T
node cli.js [--dir DATA] begin-snapshot [--id S]
node cli.js [--dir DATA] end-snapshot --id S
node cli.js [--dir DATA] get --account A [--at V]
node cli.js [--dir DATA] get --tx T
node cli.js [--dir DATA] checkpoint
node cli.js [--dir DATA] crash --point C1|C2   # crash-injection for testing
```

## Test

```
node --test
```
