"""Independent brute-force enumerator used to cross-check the solver.

Deliberately shares no logic with solver.solve: it enumerates every
(machine, start) combination per job and re-validates each partial
assignment from scratch.
"""
from __future__ import annotations

from .model import id_sort_key


class BruteForceLimit(Exception):
    """Raised when the enumeration node budget is exceeded."""


def _valid_partial(jobs, machines, horizon, chosen, upto):
    """Re-check jobs[0..upto] (indices into `jobs`) from scratch."""
    usage = {}
    finish = {}
    for i in range(upto + 1):
        job = jobs[i]
        mi, start = chosen[i]
        m = machines[mi]
        if not set(job["tags"]) <= set(m["tags"]):
            return False
        if start + job["duration"] > horizon:
            return False
        if start + job["duration"] > job["deadline"]:
            return False
        for t in range(start, start + job["duration"]):
            cell = usage.setdefault((mi, t), [0, 0])
            cell[0] += job["cpu"]
            cell[1] += job["mem"]
            if cell[0] > m["cpu"] or cell[1] > m["mem"]:
                return False
        finish[job["id"]] = start + job["duration"]
    for i in range(upto + 1):
        for d in jobs[i]["deps"]:
            if d in finish and finish[d] > chosen[i][1]:
                return False
    return True


def brute_force_feasible(jobs, machines, horizon, node_limit=5_000_000):
    """True iff any complete assignment is valid. Raises BruteForceLimit."""
    ordered = sorted(jobs, key=lambda j: id_sort_key(j["id"]))
    domains = []
    for job in ordered:
        latest = min(horizon, job["deadline"]) - job["duration"]
        dom = [
            (mi, s)
            for mi, m in enumerate(machines)
            if job["cpu"] <= m["cpu"] and job["mem"] <= m["mem"]
            and set(job["tags"]) <= set(m["tags"])
            for s in range(max(latest + 1, 0))
        ]
        if not dom:
            return False
        domains.append(dom)
    chosen = [None] * len(ordered)
    nodes = 0

    def rec(i):
        nonlocal nodes
        if i == len(ordered):
            return True
        for option in domains[i]:
            nodes += 1
            if nodes > node_limit:
                raise BruteForceLimit(f"exceeded {node_limit} nodes")
            chosen[i] = option
            if _valid_partial(ordered, machines, horizon, chosen, i):
                if rec(i + 1):
                    return True
        chosen[i] = None
        return False

    return rec(0)


def validate_schedule(jobs, machines, horizon, assign):
    """Standalone validator for a full assignment {job_id: (machine_id, start)}."""
    if set(assign) != {j["id"] for j in jobs}:
        return False
    by_id = {j["id"]: j for j in jobs}
    m_by_id = {m["id"]: m for m in machines}
    usage = {}
    finish = {}
    for jid, (mid, start) in assign.items():
        job = by_id[jid]
        m = m_by_id.get(mid)
        if m is None or not set(job["tags"]) <= set(m["tags"]):
            return False
        if start < 0 or start + job["duration"] > horizon:
            return False
        if start + job["duration"] > job["deadline"]:
            return False
        for t in range(start, start + job["duration"]):
            cell = usage.setdefault((mid, t), [0, 0])
            cell[0] += job["cpu"]
            cell[1] += job["mem"]
            if cell[0] > m["cpu"] or cell[1] > m["mem"]:
                return False
        finish[jid] = start + job["duration"]
    for jid, (_, start) in assign.items():
        for d in by_id[jid]["deps"]:
            if finish[d] > start:
                return False
    return True
