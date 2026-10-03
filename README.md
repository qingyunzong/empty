# hieroll

Hierarchical rolling-window aggregation over event streams, with
watermark-based finalization and versioned corrections. Pure Python 3.11
standard library.

## Layers

Three fixed layers of epoch-aligned, left-closed right-open windows:
`1m` (60s) ⊂ `5m` (300s) ⊂ `1h` (3600s). Every event lands in exactly one
window per layer.

## Semantics

- Input events: `{"key", "ts", "delta"}`; `delta` is an integer, positive or negative.
- Watermark per key: `WM = max_ts - late` (`late` configurable, default 0).
- A window is final once `end <= WM` and is then emitted (version 1) if non-empty.
- A correction is an event with `ts >= WM - late` landing in a final window.
  It re-emits the affected leaf window and every final ancestor window with
  the new whole-window sum and `version + 1` — never only ancestors, never
  unchanged layers. Non-final ancestors absorb the delta silently.
- Events with `ts < WM - late` are too late: dropped and counted.
- Empty windows are never emitted. Remaining non-empty windows are flushed
  at end of input.

## CLI

```
python -m hieroll --in e.jsonl --out roll.jsonl [--late SECONDS]
```

- Input: one `{"key": str, "ts": number, "delta": int}` per line.
- Output: one `{"key", "layer", "start", "end", "sum", "version"}` per line.
- A summary `{"emitted": N, "dropped": M}` is printed to stderr.
- Exit code 2 on invalid input (including a non-integer `delta`).

## Library

```python
from hieroll import HierRoll

roll = HierRoll(late=60)
records = roll.add("key", ts, delta)  # list[WindowRecord]
records = roll.close()                # flush remaining windows
roll.dropped                          # too-late event count
```

## Tests

```
python -m unittest discover -v
```
