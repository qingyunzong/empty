# LWW Register with Tombstones

Last-Writer-Wins register (Python 3.11 stdlib only), with tombstone deletes,
deterministic merge, safe GC and crash-atomic single-file persistence.

## Semantics

- Records compare by `(ts, node)` lexicographically; identical `(ts, node)`
  is the same write (idempotent apply).
- `del` writes a tombstone record. A tombstone beats concurrent puts with an
  older `(ts, node)` and loses to newer ones — one comparison rule for all.
- `merge` takes the per-key max record: commutative, associative, idempotent.
- `gc(before=T)` collects tombstones with `ts < T` only when every live
  replica's watermark has passed the tombstone's `ts`; otherwise it returns
  `GC_UNSAFE` and leaves the state untouched.
- `save` writes temp file + fsync, then atomic `rename` (+ dir fsync). A
  crash injected after the temp write and before the rename
  (`LWW_CRASH_POINT=before_rename`) leaves either the old or the new file
  fully intact — never a half-written one. The file embeds a SHA-256
  checksum verified on `load`.

Limits: at most 1000 distinct keys, values at most 64 bytes (UTF-8).

## CLI

```
python3 lww.py --node N1 --file state.json
```

Reads JSON lines on stdin, one response line per request on stdout.
Any error prints `{"ok": false, "error": CODE}` and exits with status 3.

```
{"op":"put","key":"k","value":"v"}
{"op":"get","key":"k"}                 -> {"ok":true,"value":"v"|null}
{"op":"del","key":"k"}
{"op":"merge","state":{...}}           # state from another node's dump
{"op":"gc","before":10}                -> {"ok":true,"collected":n}
{"op":"save"} / {"op":"load"}          # require --file
{"op":"dump"}                          -> full state (for merge)
```

Error codes: `BAD_INPUT`, `VALUE_TOO_LARGE`, `KEYSPACE_FULL`,
`GC_UNSAFE`, `CHECKSUM_MISMATCH`, `IO_ERROR`.

## Tests

```
python -m unittest discover -s tests -v
```
