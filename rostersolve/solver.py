"""Deterministic backtracking scheduler.

Search order is fully deterministic: jobs are placed in lexicographic
topological order (by job id), machines in ascending id order, and start
times in ascending order. The first feasible solution found is therefore
the canonical one required by the CLI contract.
"""
from __future__ import annotations

from .model import id_sort_key, topo_order


def solve(jobs, machines, horizon):
    """Search for a feasible schedule.

    Returns (assignment, trace) where assignment maps job id ->
    (machine_id, start) or is None when the instance is infeasible.
    trace is a dict {"nodes": int, "events": [...]}.
    """
    ordered = topo_order(jobs)
    by_id = {j["id"]: j for j in jobs}
    machine_list = sorted(machines, key=lambda m: id_sort_key(m["id"]))
    cpu_used = {m["id"]: [0] * horizon for m in machine_list}
    mem_used = {m["id"]: [0] * horizon for m in machine_list}
    finish = {}
    assign = {}
    events = []
    nodes = 0

    def deps_done(job, start):
        for d in by_id[job["id"]]["deps"]:
            f = finish.get(d)
            if f is None or f > start:
                return False
        return True

    def dfs(idx):
        nonlocal nodes
        if idx == len(ordered):
            return True
        job = ordered[idx]
        jid = job["id"]
        dur = job["duration"]
        latest = min(horizon, job["deadline"]) - dur
        if latest < 0:
            events.append({"op": "exhausted", "job": jid})
            return False
        for m in machine_list:
            if job["cpu"] > m["cpu"] or job["mem"] > m["mem"]:
                continue
            if not set(job["tags"]) <= set(m["tags"]):
                continue
            cu = cpu_used[m["id"]]
            mu = mem_used[m["id"]]
            for s in range(latest + 1):
                nodes += 1
                if not deps_done(job, s):
                    continue
                ok = True
                for t in range(s, s + dur):
                    if cu[t] + job["cpu"] > m["cpu"] or mu[t] + job["mem"] > m["mem"]:
                        ok = False
                        break
                if not ok:
                    continue
                for t in range(s, s + dur):
                    cu[t] += job["cpu"]
                    mu[t] += job["mem"]
                finish[jid] = s + dur
                assign[jid] = (m["id"], s)
                events.append({
                    "op": "place", "job": jid,
                    "machine": m["id"], "start": s,
                })
                if dfs(idx + 1):
                    return True
                for t in range(s, s + dur):
                    cu[t] -= job["cpu"]
                    mu[t] -= job["mem"]
                del finish[jid]
                del assign[jid]
                events.append({
                    "op": "backtrack", "job": jid,
                    "machine": m["id"], "start": s,
                })
        events.append({"op": "exhausted", "job": jid})
        return False

    feasible = dfs(0)
    trace = {"nodes": nodes, "events": events}
    return (assign if feasible else None), trace


def _restrict_jobs(jobs, keep_ids):
    keep = set(keep_ids)
    return [
        {**j, "deps": [d for d in j["deps"] if d in keep]}
        for j in jobs if j["id"] in keep
    ]


def minimal_conflict(jobs, machines, horizon):
    """Inclusion-minimal subset of job ids that is still infeasible.

    Deterministic: candidates are removed in ascending id order.
    """
    remaining = sorted((j["id"] for j in jobs), key=id_sort_key)
    for jid in list(remaining):
        trial = [x for x in remaining if x != jid]
        sub = _restrict_jobs(jobs, trial)
        sol, _ = solve(sub, machines, horizon)
        if sol is None:
            remaining = trial
    return remaining
