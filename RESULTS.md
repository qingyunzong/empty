# RESULTS

Date: 2026-10-01. All commands run from the repository root.

## Test run (primary, Python 3.11)

- Command: `python3.11 -m unittest discover -v`
- Interpreter: `Python 3.11.16` (`python3.11`; note: bare `python` is not on
  PATH in this environment, so the `python3.11` binary was used)
- Exit code: `0`
- Tests run: 15, failures: 0, errors: 0
- Result tail: `Ran 15 tests in 0.532s` / `OK`

## Test run (default python3)

- Command: `python3 -m unittest discover -v`
- Interpreter: `Python 3.14.4`
- Exit code: `0`
- Tests run: 15, failures: 0, errors: 0
- Result tail: `Ran 15 tests in 0.452s` / `OK`

## CLI smoke run

- Command: `python3.11 -m wmagg --input events.jsonl --out out.jsonl --late late.jsonl --window 100 --out-of-order 10 --idle-timeout 50`
  (run from `/tmp/wmagg-demo` with `PYTHONPATH` pointing at the repo)
- Exit code: `0`
- `out.jsonl`: `{"start": 100, "end": 200, "key": "k", "sum": 7}`
- `late.jsonl`: `{"src": "A", "ts": 90, "key": "k", "val": 16}`

## Acceptance coverage

- 3 srcs with idle + revival, compared window-by-window against an offline
  reference over the sorted event sequence:
  `TestThreeSourcesIdleRevival.test_matches_reference_window_by_window` — ok
- `end == WM` finalises, `end == WM + 1` does not:
  `TestWatermarkBoundary` (2 tests) — ok
- Same key out-of-order across `S`, late drops counted (2 late events):
  `TestOutOfOrderAndLate.test_late_drops_and_sums` — ok
- Empty input and single-event boundary:
  `TestEmptyAndSingleEvent` (3 tests) — ok
- Error handling (bad JSON, missing field, `ts < 0`, no partial output,
  missing input file): `TestInputErrors` (5 tests) — ok
- WM monotonicity on revival: `TestWatermarkMonotonic` — ok
