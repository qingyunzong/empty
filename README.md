# LWW Register with Tombstones

Last-write-wins register set (Python 3.11 stdlib only).

## Semantics

- Entries ordered by `(ts, node)` lexicographically; a full tie is the same
  write (deterministic payload tie-break keeps merge a semilattice).
- `del` writes a tombstone: it beats concurrent older puts and loses to
  newer puts by the same comparison.
- `merge` is commutative, associative and idempotent.
- `gc(before=T)` collects tombstones with `ts < T` only when every live
  replica has seen them (tracked via per-tombstone `seen_by` and a `live`
  replica set exchanged on merge); otherwise `GC_UNSAFE`, state unchanged.
- `save` writes one file atomically: tmp file + fsync, then `os.replace`,
  then dir fsync. A crash after the tmp write and before the rename (fault
  injection: env `LWW_CRASH_BEFORE_RENAME=1`) leaves either the old or the
  new file fully intact; integrity is verified with a SHA-256 checksum on
  `load`.
- Limits: at most 1000 keys (`KEYSPACE_FULL`), values <= 64 bytes
  (`VALUE_TOO_LARGE`).

## CLI

```
python3 lww.py <node-id>   # JSON lines on stdin, JSON lines on stdout
```

Commands (one JSON object per line):

```json
{"op":"put","key":"k1","value":"v","ts":1,"node":"A"}
{"op":"get","key":"k1"}
{"op":"del","key":"k1","ts":2}
{"op":"merge","state":{...}}
{"op":"dump"}
{"op":"gc","before":10}
{"op":"save","path":"state.json"}
{"op":"load","path":"state.json"}
```

`node` defaults to the CLI node id. Responses are `{"ok":true,...}` or
`{"ok":false,"error":"CODE"}`; the process exits with code 3 if any command
failed, 0 otherwise.

## Tests

```
python -m unittest discover -s tests -v
```
