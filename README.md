# hieroll

Hierarchical tumbling-window rollup (`1m` ⊂ `5m` ⊂ `1h`, epoch-aligned,
left-closed right-open) over a JSONL event stream, with watermark-based
finalization, versioned corrections, and too-late dropping.

## Semantics

- Input events: `{"key": ..., "ts": <int>, "delta": <int>}`; `delta` may be negative.
- Watermark `WM = max_ts - late`. A window with `end <= WM` is finalized and
  emitted with `version = 1`.
- A correction (`ts >= WM - late`) landing in a finalized window re-emits the
  whole new value of every affected finalized window — the leaf window and its
  finalized ancestors — with `version + 1`. Unchanged (not-yet-final) layers
  are not re-emitted; emitting only ancestors is forbidden.
- Events with `ts < WM - late` are dropped and counted (reported on stderr).
- Each event affects exactly one window per layer; empty windows are never emitted.

## CLI

```sh
python -m hieroll --in e.jsonl --out roll.jsonl [--late SECONDS]
```

Output JSONL records: `{"key", "layer", "start", "end", "value", "version"}`.
Exit code `2` on invalid input (e.g. non-integer `delta`).

## Library

```python
from hieroll import HierRoll
roll = HierRoll(late=30)
records = roll.add("key", 100, -2)  # list of emitted window records
roll.dropped                        # too-late drop counter
```

## Tests

```sh
python -m unittest discover -v
```
