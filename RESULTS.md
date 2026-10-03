# RESULTS

## Test run

- Command: `python -m unittest discover -v`
- Date: 2026-10-04 (Asia/Shanghai)
- Interpreter: Python 3.14.4 (`/usr/bin/python3`); code targets the
  Python 3.11 standard library
- **Exit code: 0**
- Result: `Ran 29 tests in 2.769s` — **OK** (29 passed, 0 failed, 0 errors)

Breakdown:

- `tests.test_core.PermutationTest` (3 tests): n<=12 exhaustive permutations
  of both sides (3x3 and 4x4 full Cartesian products, plus 300 randomized
  shuffles with up to 12 events per side) checked against a nested-loop
  reference join over deduplicated events.
- `tests.test_core.BoundEdgeTest` (8 tests): bound=5000 boundary — diff
  exactly ±5000 matches, ±5001 does not, in both arrival directions;
  bound=0 requires equal ts; wrong key never matches.
- `tests.test_core.DuplicateAndDisorderTest` (4 tests): duplicate ids
  collapse to one logical event; extreme out-of-order arrivals are dropped
  as late and counted; skew relaxes lateness; not-yet-due events are kept,
  not treated as unsatisfiable.
- `tests.test_core.EmptyStreamTest` (3 tests): one side empty still
  finalizes the other side to a deterministic empty result; both empty.
- `tests.test_core.OrderingTest` (1 test): output sorted by
  `(key, ts_l, ts_r, l_id, r_id)`.
- `tests.test_cli.HappyPathTest` (4 tests): end-to-end CLI join with sorted
  output and stderr stats; bound=0; empty right stream; late counts.
- `tests.test_cli.BadInputTest` (6 tests): bad JSON / missing field / bad
  type / missing input file / negative bound all exit 2 with no partial
  output; pre-existing output file is not clobbered on failure.

## Demo CLI run (real)

```
$ python -m bandjoin --left L.jsonl --right R.jsonl --bound 5000 --out pairs.jsonl
{"left_dup": 1, "left_late": 1, "left_total": 4, "pairs": 2, "right_dup": 0, "right_late": 0, "right_total": 3}   (stderr)
exit code: 0
```

Input L.jsonl: `l1/a/100`, `l2/b/5000`, duplicate `l2/b/5000`, `l3/a/10`
(late). Input R.jsonl: `r1/b/4900`, `r2/a/150`, `r3/a/60000`.

Output pairs.jsonl:

```
{"l_id": "l1", "r_id": "r2", "key": "a", "ts_l": 100, "ts_r": 150}
{"l_id": "l2", "r_id": "r1", "key": "b", "ts_l": 5000, "ts_r": 4900}
```
