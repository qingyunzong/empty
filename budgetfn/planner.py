"""Exact solver for the budget-constrained single-machine scheduling problem.

Semantics
---------
- Time is discrete. Tick ``t`` covers the interval [t, t+1).
- Job ``j`` may run at tick ``t`` only when ``arrival <= t < deadline``.
- A job is preemptable; each tick it runs consumes 1 unit of ``work`` and
  costs ``cost_per_tick``.
- The total cost over the whole horizon must be ``<= budget``. A tick whose
  cost would push the total above the budget may not be started.
- A job earns its ``value`` only if it is completed (all work done) at a tick
  strictly before its deadline. Work spent on a job that is never completed
  still counts towards the budget but earns nothing.
- Completion time of a job is the index ``t`` of the tick at which its last
  unit of work is executed.

Objective (lexicographic)
-------------------------
1. Maximize the sum of values of completed jobs.
2. Minimize the sum of completion times of completed jobs.
3. Minimize the per-tick schedule lexicographically, where each tick is
   represented by the job id string, or the literal string ``"idle"``.
"""

from functools import lru_cache

IDLE = "idle"

REQUIRED_FIELDS = ("id", "arrival", "deadline", "work", "cost_per_tick", "value")


class InputError(ValueError):
    """Raised for malformed job descriptions or an invalid budget."""


def validate_jobs(jobs):
    if not isinstance(jobs, list):
        raise InputError("jobs payload must be a JSON array")
    seen_ids = set()
    for pos, job in enumerate(jobs):
        if not isinstance(job, dict):
            raise InputError(f"job #{pos} must be an object")
        for field in REQUIRED_FIELDS:
            if field not in job:
                raise InputError(f"job #{pos} is missing field {field!r}")
        jid = job["id"]
        if not isinstance(jid, str):
            raise InputError(f"job #{pos}: id must be a string")
        if jid in seen_ids:
            raise InputError(f"duplicate job id {jid!r}")
        seen_ids.add(jid)
        for field in ("arrival", "deadline", "work", "cost_per_tick", "value"):
            if not isinstance(job[field], (int, float)):
                raise InputError(f"job {jid!r}: {field} must be a number")
        if job["cost_per_tick"] < 0:
            raise InputError(f"job {jid!r}: cost_per_tick must be >= 0")
        if job["work"] <= 0:
            raise InputError(f"job {jid!r}: work must be >= 1")
        if job["arrival"] < 0:
            raise InputError(f"job {jid!r}: arrival must be >= 0")
        if job["deadline"] <= job["arrival"]:
            raise InputError(
                f"job {jid!r}: deadline ({job['deadline']}) must be greater "
                f"than arrival ({job['arrival']})"
            )


def _is_better(candidate, incumbent):
    """Lexicographic comparison of (value, neg_compsum, schedule) tuples."""
    if incumbent is None:
        return True
    if candidate[0] != incumbent[0]:
        return candidate[0] > incumbent[0]
    if candidate[1] != incumbent[1]:
        return candidate[1] > incumbent[1]
    return candidate[2] < incumbent[2]


def solve(jobs, budget):
    """Return an optimal plan dict for ``jobs`` under ``budget``.

    Raises InputError on invalid input (caller maps this to exit code 2).
    """
    if budget < 0:
        raise InputError("budget must be >= 0")
    validate_jobs(jobs)

    horizon = max((job["deadline"] for job in jobs), default=0)
    if horizon == 0:
        return _plan_dict(jobs, budget, ())

    eligible = [
        tuple(
            i
            for i, job in enumerate(jobs)
            if job["arrival"] <= t < job["deadline"]
        )
        for t in range(horizon)
    ]
    costs = tuple(job["cost_per_tick"] for job in jobs)
    values = tuple(job["value"] for job in jobs)
    ids = tuple(job["id"] for job in jobs)
    initial = tuple(job["work"] for job in jobs)

    import sys

    if sys.getrecursionlimit() < horizon + 100:
        sys.setrecursionlimit(horizon + 100)

    @lru_cache(maxsize=None)
    def best(t, spent, remaining):
        """Best (value, neg_compsum, schedule_suffix) from tick t onward."""
        if t == horizon:
            return (0, 0, ())

        sub_value, sub_neg, sub_sched = best(t + 1, spent, remaining)
        winner = (sub_value, sub_neg, (IDLE,) + sub_sched)

        for i in eligible[t]:
            if remaining[i] == 0:
                continue
            cost = costs[i]
            if spent + cost > budget:
                continue
            new_remaining = list(remaining)
            new_remaining[i] -= 1
            gain_value = 0
            gain_neg = 0
            if new_remaining[i] == 0:
                gain_value = values[i]
                gain_neg = -t
            sub_value, sub_neg, sub_sched = best(
                t + 1, spent + cost, tuple(new_remaining)
            )
            candidate = (
                sub_value + gain_value,
                sub_neg + gain_neg,
                (ids[i],) + sub_sched,
            )
            if _is_better(candidate, winner):
                winner = candidate
        return winner

    _, _, schedule = best(0, 0, initial)
    return _plan_dict(jobs, budget, schedule)


def _plan_dict(jobs, budget, schedule):
    spent, earned, compsum = evaluate(jobs, budget, schedule)
    by_id = {job["id"]: job for job in jobs}
    completed = sorted(
        jid for jid in {tick for tick in schedule if tick != IDLE}
    )
    return {
        "budget": budget,
        "horizon": len(schedule),
        "spent": spent,
        "earned": earned,
        "completion_time_sum": compsum,
        "completed": [
            jid
            for jid in completed
            if sum(1 for tick in schedule if tick == jid) == by_id[jid]["work"]
        ],
        "ticks": [{"t": t, "job": schedule[t]} for t in range(len(schedule))],
    }


def evaluate(jobs, budget, schedule):
    """Score a concrete schedule.

    ``schedule`` is a sequence of job ids / ``"idle"`` of length
    ``max(deadline)``. Returns (spent, earned, completion_time_sum).
    Raises InputError if the schedule is infeasible.
    """
    horizon = max((job["deadline"] for job in jobs), default=0)
    if len(schedule) != horizon:
        raise InputError("schedule length does not match horizon")
    by_id = {job["id"]: job for job in jobs}
    remaining = {job["id"]: job["work"] for job in jobs}
    spent = 0
    earned = 0
    compsum = 0
    for t, choice in enumerate(schedule):
        if choice == IDLE:
            continue
        job = by_id.get(choice)
        if job is None:
            raise InputError(f"unknown job id {choice!r} at tick {t}")
        if not (job["arrival"] <= t < job["deadline"]):
            raise InputError(f"job {choice!r} not runnable at tick {t}")
        spent += job["cost_per_tick"]
        if spent > budget:
            raise InputError("budget exceeded")
        remaining[choice] -= 1
        if remaining[choice] < 0:
            raise InputError(f"job {choice!r} ran more ticks than its work")
        if remaining[choice] == 0:
            earned += job["value"]
            compsum += t
    return spent, earned, compsum
