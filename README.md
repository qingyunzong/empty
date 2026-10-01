# fairq

Deterministic fair-queueing simulator with priority-weighted DRF
(deficit-style) service. Python 3.11 standard library only.

## Usage

```
python -m fairq run events.json --out result.json --log log.txt
```

- `events.json`: JSON list of events (see below).
- `--out`: result JSON path (default: stdout).
- `--log`: deterministic service log path (optional; omitted if not given).
- Exit code `0` on success, `2` on any validation/IO error; errors are
  reported as a single JSON object on stderr.

## Event format

```json
{"type": "submit",   "t": 0, "flow": 1, "size": 10, "prio": 3}
{"type": "tick",     "t": 1}
{"type": "capacity", "t": 0, "c": 2}
```

- All `t` are integers; duplicate times are legal. Input events must be
  non-decreasing in `t` (otherwise `time_regression`).
- Events at the same time are applied in the order: **submit, capacity,
  tick**, then by ascending `flow` id, then by input order.
- `capacity` may omit `t`; it then inherits the previous event's time
  (or `0` if first). Default capacity before any `capacity` event is 1.

## Scheduling semantics

1. **Capacity**: `c` service units per tick; unused capacity does not
   accumulate.
2. **Weighted DRF**: each flow's weight is `max(1, prio)`. For every
   service unit the eligible flow with the smallest `served / weight`
   ratio is chosen (exact rational comparison); ties go to the smaller
   flow id.
3. **No intra-tick preemption**: a flow submitted at time `t` is not
   eligible at a tick at time `t`; arrivals take effect at the next tick.
4. **Finish**: a flow that receives its last unit at tick `t` gets
   `finish_t = t` (zero-size flows finish at their submit time).
5. **Starvation** (`W = 100`): a flow is listed in `starved` if it spends
   more than 100 time units active without service, measured over the
   gaps between its submit time, its own service times, and its finish
   time (or the last tick for unfinished flows).

## Errors (exit code 2, JSON on stderr)

| code | condition |
|---|---|
| `negative_size` | `size < 0` |
| `invalid_capacity` | `c <= 0` |
| `time_regression` | event times decrease in input order |
| `duplicate_flow` | a flow id is submitted twice |
| `invalid_event` / `invalid_input` | malformed events / top-level JSON |
| `invalid_json` / `input_unreadable` | unreadable or unparseable input file |

## Sample run (real output)

`events.json` (bundled): flows 1 and 2 (`prio 1`, size 3) at `t=0`,
flow 3 (`prio 3`, size 2) at `t=2`, capacity 1, ticks `t=1..8`.

```
$ python -m fairq run events.json --out result.json --log log.txt
$ echo $?
0
```

Service sequence (from `result.json`): `1, 2, 3, 3, 1, 2, 1, 2` at
ticks `1..8`; `finish_t`: flow 3 → 4, flow 1 → 7, flow 2 → 8;
`starved`: `[]`. Note flow 3 arrives at `t=2` but is first served at
`t=3` — no intra-tick preemption.

`log.txt`:

```
submit t=0 flow=1 size=3 prio=1 weight=1
submit t=0 flow=2 size=3 prio=1 weight=1
capacity t=0 c=1
tick t=1 serve flow=1 units=1
submit t=2 flow=3 size=2 prio=3 weight=3
tick t=2 serve flow=2 units=1
tick t=3 serve flow=3 units=1
tick t=4 serve flow=3 units=1
finish t=4 flow=3
tick t=5 serve flow=1 units=1
tick t=6 serve flow=2 units=1
tick t=7 serve flow=1 units=1
finish t=7 flow=1
tick t=8 serve flow=2 units=1
finish t=8 flow=2
```

SHA-256 of the outputs (byte-identical across repeated runs):

```
5508bb9c7a8505d4b2f2e421da29cf0e0cc761154f43ec2ff36ce950b9f73f23  result.json
8d1c082871251997c558a7bab0f2e1ab6e08a818ae04fb264d65bd82cdc28654  log.txt
```

Error example (real output):

```
$ echo '[{"type":"submit","t":0,"flow":1,"size":-2,"prio":1}]' > bad.json
$ python -m fairq run bad.json
{"code": "negative_size", "error": "event 0: size must be >= 0", "event_index": 0}
$ echo $?
2
```

## Tests

```
$ python -m unittest discover -s tests -v
...
Ran 13 tests in 2.328s

OK
```

Coverage of the acceptance criteria:

- **A** (`tests/test_fairq.py::TestAEqualWeightAlternation`): two
  equal-weight flows alternate exactly `1,2,1,2,1,2` under capacity 1.
- **B** (`TestBWeightedRatio`): prio 3 vs prio 1 under capacity 1 —
  every aligned 4-tick window is exactly 3:1; 20 ticks give exactly
  15:5. The first 10 ticks yield the deterministic 7:3 best integer
  approximation (10 unit slots cannot express 3:1 = 7.5:2.5 exactly).
- **C** (`TestCNoImmediatePreemption`): a long flow keeps the arrival
  tick; the scheduler switches to the new flow at the next tick.
- **D** (`tests/test_crosscheck.py`): 60 random scenarios (n ≤ 6 flows,
  20 ticks, incl. tick deserts) cross-checked against an independently
  written per-event reference simulator for `finish_t`, `starved`, and
  the full per-tick service sequence.
- **E** (`tests/test_cli.py`): 5 identical CLI runs produce
  byte-identical `result.json` and `log.txt`; error cases exit 2 with
  JSON on stderr.

## Layout

- `fairq/simulator.py` — validation + deterministic simulation core.
- `fairq/cli.py`, `fairq/__main__.py` — CLI entry point.
- `tests/` — unittest suite (acceptance criteria A–E).
- `events.json` — bundled sample input.
