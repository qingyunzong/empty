"""Core planning logic for budgetfn.

Semantics:
- A job may run on tick t only when arrival <= t < deadline.
- Jobs are preemptable; one tick of work costs cost_per_tick.
- Total spent must never exceed the budget: a tick that would
  overspend the budget may not be started.
- A job earns its value only if fully completed before its deadline;
  work spent on an unfinished job is still charged.
- Objective: maximize earned value; ties break by smaller sum of
  completion times, then by lexicographically smaller per-tick
  schedule (a working tick sorts before an idle tick, and working
  ticks compare by job id as strings).
- Completion time of a job is t + 1 where t is the tick on which its
  last unit of work is processed.
"""

from __future__ import annotations


class JobError(ValueError):
    """Raised for invalid job specs or budgets (CLI exit code 2)."""


REQUIRED_FIELDS = ("id", "arrival", "deadline", "work", "cost_per_tick", "value")


def _is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_jobs(data):
    """Normalize and validate the parsed JSON payload.

    Accepts either a bare list of jobs or an object with a "jobs" key.
    Raises JobError on any invalid input.
    """
    if isinstance(data, dict):
        if "jobs" not in data:
            raise JobError("jobs file object must contain a 'jobs' key")
        data = data["jobs"]
    if not isinstance(data, list):
        raise JobError("jobs file must contain a list of jobs")

    jobs = []
    for i, job in enumerate(data):
        if not isinstance(job, dict):
            raise JobError(f"job #{i} is not an object")
        for field in REQUIRED_FIELDS:
            if field not in job:
                raise JobError(f"job #{i} is missing field {field!r}")
        jid = job["id"]
        if not isinstance(jid, (str, int, float)) or isinstance(jid, bool):
            raise JobError(f"job #{i}: id must be a string or number")
        arrival = job["arrival"]
        deadline = job["deadline"]
        work = job["work"]
        cost = job["cost_per_tick"]
        value = job["value"]
        for name, num in (("arrival", arrival), ("deadline", deadline),
                          ("work", work), ("cost_per_tick", cost),
                          ("value", value)):
            if not _is_number(num):
                raise JobError(f"job #{i}: {name} must be a number")
        if deadline <= arrival:
            raise JobError(
                f"job {jid!r}: deadline ({deadline}) <= arrival ({arrival})")
        if cost < 0:
            raise JobError(f"job {jid!r}: negative cost_per_tick ({cost})")
        if work < 0:
            raise JobError(f"job {jid!r}: negative work ({work})")
        jobs.append({
            "id": jid,
            "arrival": arrival,
            "deadline": deadline,
            "work": work,
            "cost_per_tick": cost,
            "value": value,
        })
    return jobs


def validate_budget(budget):
    if not _is_number(budget):
        raise JobError(f"budget must be a number, got {budget!r}")
    if budget < 0:
        raise JobError(f"negative budget ({budget})")
    return budget


def _tick_key(job_id):
    # Working ticks sort before idle ticks; among working ticks, compare
    # job ids as strings (lexicographic tie-break).
    if job_id is None:
        return (1, "")
    return (0, str(job_id))


def plan(jobs, budget):
    """Compute an optimal schedule.

    Returns a dict with keys: budget, horizon, spent, earned, schedule
    (list of job id or "idle" per tick), completed (job ids in
    completion order) and completion_times (id -> completion time).
    """
    validate_budget(budget)
    horizon = 0
    for job in jobs:
        horizon = max(horizon, job["deadline"])
    horizon = int(horizon)

    n = len(jobs)
    works = tuple(int(job["work"]) for job in jobs)

    # DP state: (remaining_works, spent) -> (completion_sum, schedule_key)
    # The earned value of a state is fully determined by remaining_works,
    # so per state we only minimize (completion_sum, schedule_key).
    states = {(works, 0): (0, ())}
    for t in range(horizon):
        nxt = {}

        def offer(state, cand):
            prev = nxt.get(state)
            if prev is None or cand < prev:
                nxt[state] = cand

        for (rem, spent), (comp, sched) in states.items():
            offer((rem, spent), (comp, sched + ((1, ""),)))
            for j in range(n):
                job = jobs[j]
                if rem[j] <= 0:
                    continue
                if not (job["arrival"] <= t < job["deadline"]):
                    continue
                new_spent = spent + job["cost_per_tick"]
                if new_spent > budget:
                    continue
                rem2 = list(rem)
                rem2[j] -= 1
                rem2 = tuple(rem2)
                comp2 = comp + (t + 1 if rem2[j] == 0 else 0)
                offer((rem2, new_spent),
                      (comp2, sched + (_tick_key(job["id"]),)))
        states = nxt

    best_key = None
    best = None
    for (rem, spent), (comp, sched) in states.items():
        earned = sum(jobs[j]["value"] for j in range(n) if rem[j] == 0)
        key = (-earned, comp, sched)
        if best_key is None or key < best_key:
            best_key = key
            best = (rem, spent, earned, sched)

    rem, spent, earned, sched = best
    schedule = ["idle" if elem == (1, "") else _id_of(jobs, elem[1])
                for elem in sched]
    completed = []
    completion_times = {}
    done_order = {}
    # Recompute completion times from the chosen schedule.
    remaining = list(works)
    for t, elem in enumerate(sched):
        if elem == (1, ""):
            continue
        jid = _id_of(jobs, elem[1])
        idx = _index_of(jobs, elem[1])
        remaining[idx] -= 1
        if remaining[idx] == 0:
            completion_times[str(jid)] = t + 1
            completed.append(jid)
    return {
        "budget": budget,
        "horizon": horizon,
        "spent": spent,
        "earned": earned,
        "schedule": schedule,
        "completed": completed,
        "completion_times": completion_times,
    }


def _index_of(jobs, id_str):
    for i, job in enumerate(jobs):
        if str(job["id"]) == id_str:
            return i
    raise KeyError(id_str)


def _id_of(jobs, id_str):
    return jobs[_index_of(jobs, id_str)]["id"]
