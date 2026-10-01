# buildcache

Content-addressed incremental build cache with crash recovery.
Pure Python 3.11 standard library; commands are simulated as deterministic
text concatenation of dependency outputs and source contents.

## Usage

```sh
python -m buildcache scan  <dir>   # report target status (OK/OUTDATED/STALE/UNBUILT)
python -m buildcache build <dir>   # incrementally build targets
python -m buildcache clean <dir>   # remove only manifest-listed artifacts
```

`<dir>/manifest.json` declares the targets:

```json
{
  "targets": {
    "base": {"src": ["src/base.txt"], "cmd": "echo"},
    "app":  {"src": ["src/app.txt"], "deps": ["base"], "cmd": "echo"}
  }
}
```

## Semantics

- Fingerprint = SHA256 over (source path + source content) and dependency
  fingerprints; file mtimes are never used.
- Outputs are rewritten only when the fingerprint changes, via
  `<output>.tmp` + atomic rename; state (`.buildcache/state.json`) is
  persisted atomically after every target.
- Crash recovery on restart: a leftover `.tmp` is rolled back; an output
  whose rename completed but whose state update was lost is verified
  against the deterministic product and re-recorded. No half-finished
  target is ever adopted.
- A target with a missing source is STALE; its old output is preserved.
- `clean` deletes only artifacts recorded in the state/build manifest.

## Exit codes

| code | meaning                        |
|------|--------------------------------|
| 0    | success                        |
| 2    | manifest missing/invalid       |
| 3    | dependency cycle               |
| 7    | output/state write failure     |
| 75   | simulated crash (fault injection via `BUILDCACHE_FAULT`) |

## Tests

```sh
python -m unittest discover -s tests -v
```
