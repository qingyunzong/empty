# latefix

Rolling-window change streams with bounded-lateness corrections.
Python 3.11 standard library only.

## CLI

```
python -m latefix --in e.jsonl --win 30000 --late 10000
```

Input: JSONL, one `{"key": str, "ts": int, "val": number}` event per line.
Output: one JSON record per line on stdout:

```
{"key": "a", "op": "ADD", "val": 3, "version": 1, "win_end": 30000, "win_start": 0}
{"key": "a", "op": "RETRACT", "val": 3, "version": 1, "win_end": 30000, "win_start": 0}
{"key": "a", "op": "ADD", "val": 8, "version": 2, "win_end": 30000, "win_start": 0}
```

## Semantics

- Tumbling windows of size `win`, aligned to epoch; window value is the
  sum of accepted event values.
- Watermark `WM = max(ts)` seen so far; it never moves backwards
  (clock regressions are ignored via `max`, not an error).
- A window first emits `ADD` (version 1) once `end <= WM`.
- While `WM <= end + late`, a new event for an emitted window is a legal
  correction: the window emits `RETRACT` of the last added value, then
  `ADD` of the new value with an incremented version. Exactly
  `WM == end + late` is still correctable; `WM == end + late + 1` drops.
- Events arriving when `WM > end + late` are dropped.
- `RETRACT` is byte-identical to the window's last `ADD` value.
- Empty windows never emit.
- The same physical event `(key, ts, val)` arriving repeatedly is
  idempotent (no extra versions).

## Errors

- Non-numeric `val` (or otherwise malformed input line): exit code 2.
- Success: exit code 0.

## Library

- `latefix.run_stream(events, win, late)` — incremental streaming engine.
- `latefix.run_reference(events, win, late)` — batch-recompute reference
  used by the tests to cross-check the streaming engine.

## Tests

```
python -m unittest discover -v
```
