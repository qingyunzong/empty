"""Exact discrete-time scheduling solver (complete backtracking search).

The search is complete: it never reports INFEASIBLE while an undecided
branch could still yield a solution. Jobs are placed in a deterministic
topological order (lexicographically smallest by job id); for each job,
machines are tried in ascending machine-id order and start slots in
ascending order, so the first solution found is the canonical one.
"""

import heapq

from .model import id_key, subproblem


def topological_order(problem):
    """Deterministic Kahn topological order (lexicographically smallest)."""
    job_map = problem.job_map
    indegree = {job.id: len(job.deps) for job in problem.jobs}
    dependents = {job.id: [] for job in problem.jobs}
    for job in problem.jobs:
        for dep in job.deps:
            dependents[dep].append(job.id)
    counter = 0
    heap = []
    for jid, deg in indegree.items():
        if deg == 0:
            heap.append((id_key(jid), counter, jid))
            counter += 1
    heapq.heapify(heap)
    order = []
    while heap:
        _, _, jid = heapq.heappop(heap)
        order.append(job_map[jid])
        for nxt in dependents[jid]:
            indegree[nxt] -= 1
            if indegree[nxt] == 0:
                heapq.heappush(heap, (id_key(nxt), counter, nxt))
                counter += 1
    if len(order) != len(problem.jobs):
        raise ValueError("cyclic dependency graph")  # guarded by model validation
    return order


class Solver:
    """Complete backtracking solver for one Problem instance."""

    def __init__(self, problem, record_trace=False):
        self.problem = problem
        self.record_trace = record_trace
        self.events = []
        self.nodes = 0

    def _trace(self, *event):
        if self.record_trace:
            self.events.append(list(event))

    def solve(self):
        """Return {job_id: (machine_id, start)} or None if infeasible."""
        problem = self.problem
        horizon = problem.horizon
        machines = problem.machines
        ordered = topological_order(problem)

        cpu_used = {m.id: [0] * horizon for m in machines}
        mem_used = {m.id: [0] * horizon for m in machines}
        placement = {}
        finish = {}

        def fits(job, machine, start):
            cpu_row = cpu_used[machine.id]
            mem_row = mem_used[machine.id]
            for t in range(start, start + job.duration):
                if cpu_row[t] + job.cpu > machine.cpu:
                    return False
                if mem_row[t] + job.mem > machine.mem:
                    return False
            return True

        def place(job, machine, start, delta):
            cpu_row = cpu_used[machine.id]
            mem_row = mem_used[machine.id]
            for t in range(start, start + job.duration):
                cpu_row[t] += delta * job.cpu
                mem_row[t] += delta * job.mem

        def rec(index):
            if index == len(ordered):
                return dict(placement)
            self.nodes += 1
            job = ordered[index]
            earliest = 0
            for dep in job.deps:
                if finish[dep] > earliest:
                    earliest = finish[dep]
            deadline = job.deadline if job.deadline is not None else horizon
            latest = min(horizon, deadline) - job.duration
            for machine in machines:
                if job.cpu > machine.cpu or job.mem > machine.mem:
                    continue
                if not job.tags <= machine.tags:
                    continue
                start = earliest
                while start <= latest:
                    if fits(job, machine, start):
                        place(job, machine, start, +1)
                        placement[job.id] = (machine.id, start)
                        finish[job.id] = start + job.duration
                        self._trace("place", job.id, machine.id, start)
                        result = rec(index + 1)
                        if result is not None:
                            return result
                        del placement[job.id]
                        del finish[job.id]
                        place(job, machine, start, -1)
                        self._trace("unplace", job.id, machine.id, start)
                    else:
                        self._trace("reject", job.id, machine.id, start)
                    start += 1
            return None

        return rec(0)


def build_plan(problem, placement):
    """Build the FEASIBLE plan document from a placement dict."""
    job_map = problem.job_map
    slots = {m.id: [None] * problem.horizon for m in problem.machines}
    makespan = 0
    for jid, (mid, start) in placement.items():
        job = job_map[jid]
        for t in range(start, start + job.duration):
            slots[mid][t] = jid
        if start + job.duration > makespan:
            makespan = start + job.duration
    return {
        "status": "FEASIBLE",
        "makespan": makespan,
        "horizon": problem.horizon,
        "machines": [
            {"id": m.id, "slots": slots[m.id]} for m in problem.machines
        ],
    }


def minimal_conflict(problem):
    """Return a subset-minimal infeasible set of job ids (deterministic).

    Deletion-based minimization: a job is kept only if removing it makes
    the remaining subproblem feasible again.
    """
    current = [job.id for job in problem.jobs]
    if Solver(subproblem(problem, current)).solve() is not None:
        return []
    for jid in list(current):
        if len(current) == 1:
            break
        trial = [x for x in current if x != jid]
        if Solver(subproblem(problem, trial)).solve() is None:
            current = trial
    return sorted(current, key=id_key)
