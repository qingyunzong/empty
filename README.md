# gpupack

Deterministic discrete-time GPU job scheduler with preemption and restart
costs. Pure Python 3.11+ standard library, no dependencies.

## Usage

```bash
python -m gpupack schedule req.json --out alloc.json
```

* `req.json`: input instance (see below).
* `--out PATH`: write the allocation JSON to `PATH` (default: stdout).
* Exit codes: `0` success (including `INFEASIBLE` results), `2` invalid
  input (unreadable file, malformed JSON, illegal fields).

### Input format

```json
{
  "gpus":     [{"id": "g0", "mem": 8, "sm": 8}],
  "requests": [{"id": "a", "mem": 3, "sm": 3, "shareable": true,
                "preemptible": true, "arrival": 0, "duration": 6}]
}
```

All times are integers. `id` fields are strings or integers (unique and
homogeneous per list). `mem`/`sm` are integers `>= 0`, `arrival >= 0`,
`duration >= 1`, `shareable`/`preemptible` are booleans. Any illegal field
(missing, wrong type, out of range, duplicate ids) exits with code `2`.

### Output format

```json
{
  "status": "OK",
  "objective": 20,
  "jobs": [
    {"id": "a", "start": 0, "end": 6, "gpu": "g0", "preemptions": 0}
  ]
}
```

* `start`: tick of the job's first start; `end`: completion tick;
  `gpu`: GPU where the job finished its final run; `preemptions`: number
  of times the job was evicted. Jobs are sorted by `id`.
* If no feasible schedule exists the output is `{"status": "INFEASIBLE"}`
  and the CLI prints `INFEASIBLE`. A job whose `mem`/`sm` exceeds *every*
  GPU (shareable or not) makes the instance `INFEASIBLE`.

## Scheduling semantics

* Time is discrete. A job started at tick `t` with run length `L` occupies
  ticks `t .. t+L-1` and completes at `t+L`.
* A non-shareable job owns its GPU exclusively. Shareable jobs may coexist
  on one GPU as long as summed `mem` and `sm` fit the GPU's capacity.
* Priority key is `(-arrival, id)`; the smaller key wins (a later arrival
  means higher priority, ties broken by smaller id). Only
  `preemptible: true` jobs may be evicted, and only by a strictly
  higher-priority job starting on the same GPU that needs the room.
* An evicted job becomes `PREEMPTED` and keeps its remaining work. Its
  next run costs 1 extra restart tick (run length = remaining + 1), it may
  restart at the earliest on the tick after the eviction, and it may not
  return to its previous GPU while that GPU is still occupied.
* Per GPU and tick: at most 1 start, any number of completions, any number
  of evictions.
* Objective: minimise the sum of completion times. Ties are broken by the
  lexicographically smallest sequence of per-job records
  `(start, end, gpu, preemptions)` with jobs ordered by `id`.

## Solver

`gpupack/solver.py` performs an exact depth-first search over decision
epochs (arrivals, completions, and every tick while work is pending) with
branch-and-bound, a safe lower bound, and memoisation. All iteration order
is sorted, so the output is byte-identical across runs and hash seeds.

## Tests

```bash
python -m unittest discover -s tests -v
```

Coverage:

* `tests/test_a_packing.py` — two shareable small jobs bin-packed on one GPU.
* `tests/test_b_preemption.py` — higher-priority arrival evicts a running
  job; verifies the 1-tick restart cost (`end = restart + remaining + 1`).
* `tests/test_c_conflict.py` — non-shareable big job vs. shareable job
  ordering (short-job-first wins; preemptible variant gets evicted).
* `tests/test_d_enumeration.py` — 25 random + 2 fixed instances with
  `<=5` jobs and `<=2` GPUs cross-checked against an independent
  brute-force enumerator of all legal schedules.
* `tests/test_e_determinism.py` — CLI run 3 times with different
  `PYTHONHASHSEED` values; output files are byte-identical.
* `tests/test_cli.py` — exit code 2 on illegal fields, `INFEASIBLE`
  handling, empty request list.

## Recorded run (this checkout)

Environment: Python 3.14.4, Linux.

```
$ python -m unittest discover -s tests -v
...
Ran 21 tests in 1.127s
OK
```

CLI example (exit code 0):

```
$ python -m gpupack schedule examples/req.json --out examples/alloc.json
OK objective=20 jobs=4 -> examples/alloc.json
```

Result: `a: 0->6@g0`, `b: 1->4@g0`, `c: 2->4@g1`, `d: 0->6@g0`
(`d` is evicted once by the higher-priority `c` at t=2 and restarts on
`g0` at t=3 with the 1-tick restart penalty). Objective = 20.

SHA-256 of the produced files:

```
cb51423616ed2a64aedbb9cba8c6744fb7ef8652037f749127ccf0af95a85fa8  examples/alloc.json
4c83a4bbe3d39cf12adcda563b28c85429ba64f29fe5eafcae7317e0280209bf  examples/req.json
```
