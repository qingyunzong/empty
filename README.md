# auditlog

Append-only audit log with a SHA256 hash chain, periodic snapshots,
verification and deterministic replay. Python 3.11+ standard library only.

## Record format

Each record is one line in `audit.log`:

```
length|payload_b64|prev_hash|hash
```

`hash = sha256(length|payload|prev_hash)`; the first record's `prev_hash`
is 64 zero hex digits.

## Append protocol and crash points

Append order: write temp record file (`audit.log.tmp`) -> fsync -> atomic
rename over `audit.log` -> update `HEAD` (also via temp + atomic rename).

Only three crash points are defined:

1. **Before rename** — recovery discards `audit.log.tmp`; the staged record
   is lost.
2. **After rename, HEAD stale** — recovery scans the valid tail records and
   rebuilds `HEAD`.
3. **Half-written snapshot** — the staged/corrupt snapshot is deleted and
   the previous complete snapshot (`snapshot.json.bak`) is restored.

## Verify and replay

`verify` walks the chain and stops at the first broken record, raising
`PolicyError` with code `E_CHAIN` and the record's byte offset/index — it
never guesses past a break. `replay` deterministically rebuilds the
in-memory state (payloads are `key=value`; last write wins), starting from
the newest valid snapshot when one matches the chain.

## CLI

```
python -m auditlog [--dir DIR] [--snapshot-every N] append KEY=VALUE...
python -m auditlog [--dir DIR] verify
python -m auditlog [--dir DIR] replay
python -m auditlog [--dir DIR] snapshot
```

All `PolicyError` failures print `error[CODE]: ...` to stderr and exit 2.

## Tests

```
python -m unittest discover -s tests -v
```
