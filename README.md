# budgetfn

Exact budget-constrained single-machine job scheduler. Standard library only
(Python 3.11+), tested with `unittest`.

## Usage

```
python -m budgetfn plan jobs.json --budget B --out plan.json
```

`jobs.json` is a JSON array of jobs:

```json
[{"id": "render", "arrival": 0, "deadline": 4, "work": 2, "cost_per_tick": 3, "value": 50}]
```

The plan written to `--out` contains `budget`, `horizon`, `spent`, `earned`,
`completion_time_sum`, `completed` (ids of finished jobs) and one entry per
tick: `{"t": <tick>, "job": <job_id or "idle">}`.

## Semantics

- Time is discrete; tick `t` covers `[t, t+1)`. A job may run at tick `t`
  only when `arrival <= t < deadline`. Jobs are preemptable.
- Each tick a job runs consumes 1 unit of its `work` and costs
  `cost_per_tick`. The machine runs at most one job per tick.
- Total cost over the horizon must be `<= B`; a tick whose cost would exceed
  the remaining budget is never started.
- A job earns its `value` only when fully completed before its deadline.
  Money spent on a job that is never completed is lost (still counts towards
  `spent`, earns nothing).
- Completion time of a job is the index `t` of the tick at which its last
  unit of work executes.

## Objective (lexicographic)

1. Maximize the sum of values of completed jobs.
2. Tie-break: minimize the sum of completion times of completed jobs.
3. Tie-break: minimize the per-tick schedule lexicographically, comparing
   job-id strings tick by tick (`"idle"` is the literal string).

The solver is an exact dynamic program over `(tick, spent, remaining_work)`
with memoization, so the output is fully deterministic: the same input always
produces byte-identical `plan.json`.

## Errors (exit code 2)

The CLI exits with code `2` (and writes no plan file) when:

- `deadline <= arrival` for any job,
- `--budget` is negative,
- any `cost_per_tick` is negative,
- the jobs file is missing/malformed, a job is missing a field, `work < 1`,
  `arrival < 0`, ids are duplicated or not strings.

If the budget is too small to complete anything (including `B = 0`), the CLI
still exits `0` and writes a legal all-idle plan — never `INFEASIBLE`.

## Tests

```
python -m unittest discover -s tests -v
```

Last run on this machine (Python 3.14.4): **19 tests, OK, ~4.7 s**, covering:

- A: budget exactly covers the high-value job; the low-value job is dropped.
- B: a preemptable long job stopped mid-way by the budget earns 0 while its
  partial spend still counts; the optimizer then prefers a legal all-idle plan.
- C: equal-value ties resolve by smaller completion-time sum, then by
  lexicographic job id.
- D: cross-check against exhaustive per-tick enumeration (60 random instances
  with <= 4 jobs / horizon <= 7, plus 8-job / horizon-15 instances with
  disjoint and overlapping 2-tick windows) — value, completion-time sum and
  the full schedule all match.
- E: the same input planned 5 times via the CLI yields byte-identical output.

## Recorded CLI runs (real output)

Using `examples/jobs.json` (render/backup/report):

| Command | Exit | spent | earned | sha256 of plan |
|---|---|---|---|---|
| `python -m budgetfn plan examples/jobs.json --budget 8 --out plan.json` | 0 | 8 | 70 | `d6f2e7b41f941dae74e9281d8c244a160dd064a07105931177561a05d9f53575` |
| `python -m budgetfn plan examples/jobs.json --budget 0 --out plan.json` | 0 | 0 | 0 | `1ab72cdc96d62b354e6e703e05c089270bd6267e36a68f515d031611bfbff991` |
| `python -m budgetfn plan examples/jobs.json --budget -1 --out plan.json` | 2 | — | — | no file written |

With `--budget 8` the plan completes `render` (ticks 0–1) and `backup`
(ticks 2–3) for `earned = 70`; `report` is dropped because the budget cannot
also cover it. With `--budget 0` the plan is all-idle with `spent = 0`.
