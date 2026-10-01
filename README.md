# fairq

Deterministic weighted-DRF (deficit round robin) flow scheduler simulator.
Python 3.11, standard library only.

## Usage

```
python -m fairq run events.json --out result.json --log log.txt
```

- `events.json`: JSON array of events (see below).
- `--out`: result JSON path (default: stdout).
- `--log`: deterministic event/service log path (optional).
- `--window`: starvation window `W` (default: 100).

Exit codes: `0` success, `2` invalid input (negative size, `capacity <= 0`,
time regression, malformed events, ...). On exit code 2 a JSON object
`{"error": "..."}` is printed to stderr.

## Event format

```json
{"type": "submit",   "t": 0, "flow": 1, "size": 6, "prio": 3}
{"type": "tick",     "t": 1}
{"type": "capacity", "t": 2, "c": 1}
```

- All `t` are integers; repeated timestamps are legal. Timestamps must be
  non-decreasing in input order (otherwise: time regression, exit code 2).
- `capacity` may omit `t`; it then applies at the current time. Capacity
  defaults to `1` before the first `capacity` event.
- Flow ids may be integers or strings and must be unique per run.
- `size` must be a positive integer; `prio` any integer
  (`weight = max(1, prio)`); `c` must be `> 0`.

## Scheduling semantics

1. **Ordering.** Events at the same timestamp are processed as: submits
   (ascending flow id), then capacity changes (input order), then ticks
   (input order).
2. **Capacity.** Capacity `c` is the number of service units per tick.
   Unused capacity does not accumulate.
3. **Weighted DRF.** Each tick serves up to `c` units, one unit at a time.
   Each unit goes to the eligible unfinished flow with the smallest
   `served / weight` ratio (exact fraction arithmetic); ties go to the
   smallest flow id.
4. **No immediate preemption.** A flow submitted at time `t` is *not*
   eligible at ticks with the same `t`; it takes effect from the next tick.
5. **Finish.** `finish_t` is the timestamp of the tick on which a flow's
   last unit is served (`null` if unfinished at the end of the input).
6. **Starvation.** At a tick where service happened (system non-empty), an
   unfinished flow with `t - max(submit_t, last_service_t) > W` (W = 100)
   is marked starved once and listed in `starved`.

Note on integer ratios: with unit service, 10 ticks at weights 3:1 split
7:3 (the closest integer split of 7.5:2.5); over 20 ticks the split is
exactly 15:5 = 3:1. Both facts are asserted by the test suite.

## Output

`result.json`:

```json
{
  "window": 100,
  "flows": {"1": {"submit_t": 0, "size": 6, "prio": 3, "weight": 3,
                  "served": 6, "finish_t": 10}},
  "starved": []
}
```

The log contains one line per processed event, served unit, finish and
starvation mark, e.g. `t=4 tick serve flow=1 remaining=3`. It is
byte-identical across runs with the same input (verified by 5 repeated
CLI runs in the test suite).

## Verified results (recorded from actual runs)

Test suite (`python -m unittest discover -s tests -v`):

```
Ran 10 tests in 4.695s
OK
```

Acceptance coverage: A exact alternation of two equal-weight flows,
B 3:1 weighted ratio (7:3 over 10 ticks, 15:5 over 20), C no immediate
preemption with switch at the next tick, D cross-check of `finish_t` and
`starved` against an independent event-by-event reference simulator
(n <= 6 flows, 20 ticks, 80 seeded cases, W=100 and W=3), E byte-identical
logs over 5 runs, plus error exit codes and the CLI sample below.

CLI sample (`python -m fairq run events.json --out result.json --log log.txt`):

- exit code: `0`
- sha256(`result.json`): `151c739fc3ca697298acaef3c24c07796de37d9f6a933e4dc661ea3bfd25e26c`
- sha256(`log.txt`): `0ce28f09bfe98beda842689c4207a34d4f9da3d87725ff60df63bd8a339c56e3`
- finishes: flow 3 at t=6, flow 1 at t=10, flow 2 at t=14; `starved` empty.

Error sample (`size: -2`): exit code `2`,
stderr `{"error": "event #0: negative size (-2)"}`.

## Layout

- `fairq/simulator.py` — event validation/normalization and the scheduler.
- `fairq/cli.py` — argument parsing, I/O, exit codes.
- `tests/test_fairq.py` — acceptance tests A–E plus error and CLI tests.
- `events.json` — sample input used above.
