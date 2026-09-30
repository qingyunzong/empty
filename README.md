# wmagg

Watermark-based rolling-window aggregation over JSONL event streams.
Pure Python 3.11 standard library; tests use `unittest`.

## Usage

```
python -m wmagg --input events.jsonl --out out.jsonl [--late late.jsonl] \
    --window W --out-of-order S --idle-timeout I
```

- Input: one `{"src", "ts", "key", "val"}` object per line; `ts` is event
  time in milliseconds (`>= 0`).
- Output (`--out`): one `{"start", "end", "key", "sum"}` object per line for
  every finalised window/key, ordered by `(start, key)`.
- Late events (`--late`, default `late.jsonl`): events with `ts < WM - S`,
  recorded as their original `{"src", "ts", "key", "val"}`; they never
  correct already-finalised output.

## Semantics

- Watermark `WM = max(0, min over active srcs of their max ts) - S`;
  `WM` is monotonic and never regresses.
- A src with no event for more than `I` ms of event time (vs. the global max
  ts) is idle and excluded from the min; any new accepted event revives it.
- Tumbling windows `[start, end)` of length `W` (left-closed, right-open)
  are finalised only when `end <= WM`; there is no end-of-input flush.

## Errors

Bad JSON lines, missing fields, or `ts < 0` (and other invalid field types)
cause exit code `2` with a message on stderr. Output files are written only
after the whole input validates, so a failed run leaves no partial results.

## Tests

```
python -m unittest discover -v
```
