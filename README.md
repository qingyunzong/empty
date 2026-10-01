# budgetfn

Budget-constrained single-machine job scheduler. Computes an optimal
per-tick schedule that maximizes earned value under a hard cost budget.

Requires Python 3.11+ (standard library only).

## Usage

```
python -m budgetfn plan jobs.json --budget B --out plan.json
```

`jobs.json` is a list (or an object with a `"jobs"` key) of jobs:

```json
[{"id": "high", "arrival": 0, "deadline": 5, "work": 3, "cost_per_tick": 2, "value": 100}]
```

## Semantics

- A job may run on tick `t` only when `arrival <= t < deadline`; jobs are
  preemptable and each working tick processes 1 unit of work and charges
  `cost_per_tick`.
- Hard budget: total spent never exceeds `B`; a tick that would overspend
  the budget is never started.
- A job earns its `value` only if fully completed before its deadline;
  money spent on an unfinished job is still charged (value 0).
- Objective: maximize total earned value. Ties break by (1) smaller sum of
  completion times (completion time = `t + 1` for the finishing tick `t`),
  then (2) lexicographically smallest per-tick schedule, where a working
  tick sorts before an idle tick and working ticks compare by job id as
  strings.
- If the budget is too small or no job can complete, the output is still a
  legal (possibly all-idle) plan with exit code 0 — never `INFEASIBLE`.

## Output

`plan.json` (keys sorted, deterministic bytes for identical input):

- `budget`, `horizon`, `spent`, `earned`
- `schedule`: per-tick job id or `"idle"`
- `completed`: job ids in completion order
- `completion_times`: job id -> completion time

## Exit codes

- `0` — plan written (including all-idle plans)
- `2` — invalid input: `deadline <= arrival`, negative budget, negative
  `cost_per_tick`, missing/malformed jobs file, or unwritable output

## Algorithm

Dynamic programming over ticks with state `(remaining_work_per_job, spent)`.
Earned value is determined by the state, so per state only
`(completion_time_sum, schedule_key)` is minimized; the final state is
chosen by the full objective ordering above. Exact (optimal) for any input;
practical for small/medium horizons and budgets.

## Verified results (actually executed)

Tests: `python -m unittest discover -s tests -v` — 24 tests, all OK
(acceptance A–E covered: budget-exact high-value selection, preempted
half-finished job earning 0, completion-time and job-id tie-breaks,
exhaustive enumeration cross-check for <=8 jobs / horizon <=15, and
byte-identical output across 5 repeated runs).

CLI runs against `examples/jobs.json` (high: work 3, cost 2, value 100;
low: work 2, cost 2, value 10; both windows [0,5)):

| Command | Exit | spent | earned | sha256 of plan.json |
|---|---|---|---|---|
| `python -m budgetfn plan examples/jobs.json --budget 6 --out plan.json` | 0 | 6 | 100 | `a10ab68db1ab8777fe3a1dddebe82178a1f3c64c831daa2194b360410d58774a` |
| `python -m budgetfn plan examples/jobs.json --budget 0 --out plan.json` | 0 | 0 | 0 | `e1f907ac20593d452ccbbfb4606ac8bf8f0226ea57b247ac8031325c2e80c538` |

Error cases (all exit code 2, verified): `deadline <= arrival`
(`error: job 'x': deadline (2) <= arrival (2)`), negative budget
(`error: negative budget (-1)`), negative cost
(`error: job 'x': negative cost_per_tick (-1)`).

With `--budget 6` the schedule is `["high", "high", "high", "idle", "idle"]`
(the low-value job is dropped); with `--budget 0` it is all idle.

## Layout

- `budgetfn/core.py` — validation + exact DP planner
- `budgetfn/__main__.py` — CLI entry point
- `tests/test_planner.py` — planner acceptance tests (A–D) and validation
- `tests/test_cli.py` — CLI tests including determinism (E) and exit codes
- `examples/jobs.json` — example input used above
