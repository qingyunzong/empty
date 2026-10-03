# bandjoin

Band join of two JSONL event streams with per-side watermarks.
Pure Python 3.11+ standard library, no dependencies.

## Usage

```
python -m bandjoin --left L.jsonl --right R.jsonl --bound 5000 --out pairs.jsonl
```

Optional flags: `--left-skew S`, `--right-skew S` (watermark skews, default 0).

Each input line is `{"id": ..., "key": ..., "ts": ...}` (`id`/`key`: string
or integer, `ts`: finite number; blank lines are skipped). Each output line
is `{"l_id", "r_id", "key", "ts_l", "ts_r"}`.

## Semantics

- A pair matches when `l.key == r.key` and `|l.ts - r.ts| <= bound`
  (inclusive; `bound=0` requires equal timestamps).
- Each side keeps an independent watermark `WM = max_ts_seen - skew`,
  meaning "no future event on this side will have `ts < WM`".
- The match safe point is `min(LWM, RWM) + bound`. An event is evicted from
  join state only when `ts + bound < other_side_WM`, i.e. no future event on
  the other side could still match it; events are never treated as
  unsatisfiable just because the other side has not caught up.
- An arriving event on either side is late — dropped and counted — when
  `ts < max(LWM, RWM) - bound`.
- Duplicate ids on the same side are the same logical event: first
  occurrence wins, later ones are counted as duplicates.
- Output is sorted deterministically by `(key, l.ts, r.ts, l_id, r_id)`.
- The CLI consumes the two files round-robin (one left line, one right
  line, ...) as a deterministic interleaving of the two arrival streams.

## Exit codes

- `0` — success; stats JSON is printed to stderr.
- `2` — invalid input (bad JSON line, missing/ill-typed field, unreadable
  input file, bad arguments). No output is written and a pre-existing
  output file is left untouched (output is written atomically via
  temp-file + rename only after both inputs are fully validated).
- `1` — output file could not be written.

## Tests

```
python -m unittest discover -v
```
