# latefix

Rolling-window change streams with watermark finalization and lateness corrections.
Pure Python 3.11+ standard library, no dependencies.

## CLI

```sh
python -m latefix --in e.jsonl --win 30000 --late 10000 [--out out.jsonl]
```

Input: JSONL, one `{"key": ..., "ts": <ms>, "val": <number>}` per line.
Output: JSONL change stream, one record per line:

```json
{"key":"a","start":0,"end":30000,"op":"ADD","val":30,"version":1}
{"key":"a","start":0,"end":30000,"op":"RETRACT","val":30,"version":1}
{"key":"a","start":0,"end":30000,"op":"ADD","val":35,"version":2}
```

## Semantics

- Windows are tumbling per `key`: `[floor(ts/win)*win, +win)`; window value = sum of `val`.
- Watermark `WM = max(ts)` over all seen events; it never regresses (a stale
  clock is ignored, not an error).
- A window's value is first emitted as `ADD` with `version=1` once `end <= WM`.
- A late event for an emitted window is accepted while `WM <= end + late`
  (boundary inclusive): it emits `RETRACT` of the exact last-`ADD` payload
  (byte-identical `val`/`version`), then `ADD` of the new value with
  `version+1`. Events arriving when `WM > end + late` are dropped.
- Empty windows never emit.
- Duplicate physical events (same `key`, `ts`, `val`) are idempotent: no
  double-count, no extra versions.

## Errors

Exit code `2` (message on stderr) for: non-numeric `val` (also non-numeric
`ts`, missing fields), invalid JSON lines, missing input file, invalid
`--win`/`--late`. Exit code `0` on success.

## Library

```python
from latefix import Engine, run
out = run([{"key": "a", "ts": 1000, "val": 10}, ...], win=30000, late=10000)
```

## Tests

```sh
python -m unittest discover -v
```
