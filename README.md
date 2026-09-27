# auditlog

Append-only audit log with a SHA256 hash chain, periodic snapshots,
crash recovery, verification and deterministic replay. Python 3.11+
standard library only.

## Layout

```
<dir>/HEAD                  "<seq> <hash>" of last committed record (atomic)
<dir>/records/00000001.rec  one record per file: length|payload|prev_hash|hash\n
<dir>/snapshots/00000003.snap  JSON {seq, head, state, checksum}
```

Append order: write temp record -> fsync -> atomic rename -> update HEAD.

## Crash model and recovery (on every open)

1. Crash before rename: the temp record is discarded (tail lost).
2. Crash after rename with stale HEAD: tail valid records are scanned
   and HEAD is rebuilt (tail recovered).
3. Half-written snapshot: deleted; the previous complete snapshot is used.

## CLI

```
python -m auditlog append   --dir D "SET key value"
python -m auditlog verify   --dir D        # exit 2 + E_CHAIN on first bad record
python -m auditlog replay   --dir D [--full]
python -m auditlog snapshot --dir D
```

`verify` stops at the first broken record and reports its sequence number
and logical byte offset (`PolicyError` code `E_CHAIN`, CLI exit code 2).
`replay` deterministically rebuilds state (`SET k v` / `DEL k` payloads);
replaying from a snapshot point equals full replay.

## Tests

```
python -m unittest discover -s tests -v
```
