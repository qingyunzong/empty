# bandjoin

Watermark-driven temporal band join of two JSONL event streams, plus a CLI.
Python 3.11+ standard library only.

## CLI

```
python -m bandjoin --left L.jsonl --right R.jsonl --bound 5000 --out pairs.jsonl \
    [--left-skew S] [--right-skew S]
```

* Input lines: `{"id": ..., "key": ..., "ts": ...}` (`id` str/int, `key` str/number, `ts` number).
* Output lines: `{"l_id": ..., "r_id": ..., "key": ..., "ts_l": ..., "ts_r": ...}`,
  deterministically sorted by `(key, ts_l, ts_r, l_id, r_id)`.
* The two streams are replayed merged by event timestamp (ties: left first,
  then file order); per-side watermarks are `max(ts) - skew`.
* Exit codes: `0` success; `2` bad input line or bad arguments (output is
  never created or partially written); `1` output I/O failure.
* Statistics (counts, watermarks, safe point) are printed as JSON to stderr.

## Semantics

* A left/right pair matches when `key` is equal and `|ts_l - ts_r| <= bound`
  (`bound = 0` requires equal timestamps).
* Repeated `id` on one side is the same logical event: first occurrence wins,
  later ones are counted as duplicates.
* Lateness safe point: `max(LWM, RWM) - bound`. An event arriving with `ts`
  strictly below it is dropped and counted as late; events merely out of
  order within the bound are kept (`未到期 != 不可满足`).
* Match safe point: `min(LWM + bound, RWM + bound)`; pairs are emitted only
  once the watermarks guarantee no further matching events can appear
  (the CLI finalises both streams, then writes the sorted result atomically
  via a temp file + rename).

## Library

```python
from bandjoin import BandJoin
join = BandJoin(bound=5000, left_skew=0, right_skew=0)
join.add_left({"id": "a", "key": "x", "ts": 1000})
join.add_right({"id": "p", "key": "x", "ts": 5500})
pairs = join.finalise()   # sorted list of pair dicts
stats = join.stats()      # counts, watermarks, safe point
```

## Tests

```
python -m unittest discover -v
```

See `RESULTS.md` for the recorded run.
