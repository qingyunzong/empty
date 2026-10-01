# wmagg

Watermark-based tumbling-window per-key aggregation over JSONL event streams.
Python 3.11+ standard library only.

## Usage

```
python -m wmagg --input events.jsonl --out out.jsonl \
    --late late.jsonl --window W --lateness S --idle-timeout I
```

- Input: one JSON object per line, `{"src", "ts", "key", "val"}`, `ts` in ms.
- Output `out.jsonl`: `{"start", "end", "key", "sum"}` per finalised window.
- `--late` (default `late.jsonl`): late events, in arrival order.
- Exit codes: `0` success; `2` on bad JSON, missing fields, `ts < 0`,
  invalid parameters, or I/O errors (message on stderr, no partial output).

## Semantics

- Watermark `WM = max(0, min(max ts of each active src) - S)`, never decreases.
- A src with no event for more than `I` ms of event time is idle and excluded
  from the min; a new event revives it.
- Windows are `[start, start + W)`, left-closed right-open; a window is
  finalised once `end <= WM`.
- An event with `ts < WM - S` (or whose window is already finalised) is late:
  written to the late file, never correcting emitted output.

## Tests

```
python -m unittest discover -v
```
