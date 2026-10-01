# retractop

Event-time tumbling-window TopK over an add/retract JSONL stream, emitting
retraction-style diffs (`-` old rows / `+` new rows) whenever a window's
result changes. Pure Python 3.11+ standard library.

## CLI

```
python -m retractop --in ops.jsonl --k 3 --win 60000 [--allowed-lateness MS] [--out FILE]
```

- Input: JSONL, one `{"op","ts","key","score","id"}` per line, `op` = `add` | `retract`.
- Output (stdout or `--out`): JSONL diff records
  `{"op":"+"|"-","window_end":...,"key":...,"score":...,"id":...}`.
- stderr: final summary `{"invalid": N, "dropped": M}`.
- Exit codes: `0` ok; `2` malformed input line (unknown ops are *not* errors,
  they are counted as `invalid`).

## Semantics

- Windows are tumbling: `[start, start+win)`, `start = floor(ts/win)*win`.
- Watermark = max `ts` seen; never regresses. A window finalizes when
  `WM >= window_end`; EOF finalizes everything.
- Ranking: score desc, key asc, id asc; fewer than K live items emits only
  the actual rows.
- `add` with an already-active id -> invalid. `retract` must match an active
  add on id **and** key/score, else invalid (never crashes).
- Legal late events landing in a final window emit a correction diff while
  `WM <= window_end + allowed_lateness`; older ones are dropped (counted).
- Output is a pure function of the input: deterministic and replayable.

## Tests

```
python -m unittest discover -v
```
