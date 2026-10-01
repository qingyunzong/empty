"""Discrete-time GPU scheduler with preemption and restart costs.

Tick model (integer time):
  * At each integer time t, completions (jobs whose remaining work hit 0)
    leave their GPUs first, then the scheduler may evict any number of
    running preemptible jobs and start at most one job per GPU.
  * A job started at t occupies its GPU during [t, t+1). A first-time start
    makes progress immediately; a job restarted after preemption spends its
    first tick as a restart tick (occupies the GPU, no progress).
  * A job with duration d started at t and never preempted ends at t + d.

Priority: (-arrival, id); the smaller tuple has higher priority, i.e. later
arrivals preempt earlier ones, ties broken by smaller id.

An eviction is legal only when it is "caused" by a strictly higher-priority
job that starts on the same GPU in the same tick. A restarted job may not
return to the GPU it was evicted from while that GPU is still occupied.
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations

from .model import Problem, id_key

# Runtime entry fields (entries are tuples so states stay hashable).
REM, NEEDS_RS, RESTARTING, GPU, PREV, DONE, END, START, PREEMPTS, FGPU = range(10)

MAX_NODES = 2_000_000


def initial_state(problem: Problem) -> tuple:
    entries = tuple(
        (job.duration, 0, 0, -1, -1, 0, -1, -1, 0, -1) for job in problem.jobs
    )
    return (0, entries)


def memo_key(state: tuple) -> tuple:
    t, entries = state
    return (
        t,
        tuple(
            (e[REM], e[NEEDS_RS], e[RESTARTING], e[GPU], e[PREV], e[DONE])
            for e in entries
        ),
    )


def done_cost(state: tuple) -> int:
    return sum(e[END] for e in state[1] if e[DONE])


def tie_key(problem: Problem, state: tuple) -> tuple:
    """Lexicographic tie-break: per job (sorted by id) (start, end, gpu, preemptions)."""
    _, entries = state
    order = sorted(range(len(entries)), key=lambda i: id_key(problem.jobs[i].id))
    return tuple(
        (
            entries[i][START],
            entries[i][END],
            id_key(problem.gpus[entries[i][FGPU]].id),
            entries[i][PREEMPTS],
        )
        for i in order
    )


class Engine:
    """Generates legal actions and applies them to states."""

    def __init__(self, problem: Problem):
        self.problem = problem
        self.prio = [(-j.arrival, id_key(j.id)) for j in problem.jobs]
        self.fits = [
            [j.mem <= g.mem and j.sm <= g.sm for g in problem.gpus]
            for j in problem.jobs
        ]

    def is_terminal(self, state: tuple) -> bool:
        return all(e[DONE] for e in state[1])

    def can_place(self, state, j, g, occupants, ev=frozenset()) -> bool:
        problem = self.problem
        job = problem.jobs[j]
        gpu = problem.gpus[g]
        if not self.fits[j][g]:
            return False
        e = state[1][j]
        needs_restart = e[NEEDS_RS] or j in ev
        prev_gpu = e[GPU] if j in ev else e[PREV]
        if needs_restart and prev_gpu == g and occupants:
            # May not return to the original GPU while it is still occupied.
            return False
        if not occupants:
            return True
        if not job.shareable:
            return False
        mem = job.mem
        sm = job.sm
        for o in occupants:
            other = problem.jobs[o]
            if not other.shareable:
                return False
            mem += other.mem
            sm += other.sm
        return mem <= gpu.mem and sm <= gpu.sm

    def _assignments(self, state, pool, occupants, ev):
        """All ways to start at most one pooled job per GPU."""
        ngpu = len(self.problem.gpus)
        results = []

        def rec(g, used, current):
            if g == ngpu:
                results.append(dict(current))
                return
            rec(g + 1, used, current)
            for j in pool:
                if j in used:
                    continue
                if self.can_place(state, j, g, occupants[g], ev):
                    current[g] = j
                    rec(g + 1, used | {j}, current)
                    del current[g]

        rec(0, frozenset(), {})
        return results

    def actions(self, state):
        """All legal (evictions, starts) action pairs for the current tick."""
        problem = self.problem
        t, entries = state
        n = len(entries)
        ngpu = len(problem.gpus)
        running = [i for i in range(n) if entries[i][GPU] >= 0]
        waiting = [
            i
            for i in range(n)
            if not entries[i][DONE]
            and entries[i][GPU] < 0
            and problem.jobs[i].arrival <= t
        ]
        candidates = [i for i in running if problem.jobs[i].preemptible]
        results = []
        for r in range(len(candidates) + 1):
            for ev_tuple in combinations(candidates, r):
                ev = frozenset(ev_tuple)
                occupants = [
                    [i for i in running if entries[i][GPU] == g and i not in ev]
                    for g in range(ngpu)
                ]
                pool = waiting + list(ev_tuple)
                for starts in self._assignments(state, pool, occupants, ev):
                    if self._justified(ev, starts, entries):
                        results.append((ev, starts))
        return results

    def _justified(self, ev, starts, entries) -> bool:
        """Every evicted job must be displaced by a strictly higher-priority
        job starting on the same GPU in the same tick."""
        for j in ev:
            g = entries[j][GPU]
            k = starts.get(g)
            if k is None or not self.prio[k] < self.prio[j]:
                return False
        return True

    def step(self, state, action):
        problem = self.problem
        t, entries = state
        ev, starts = action
        rows = [list(e) for e in entries]
        for j in ev:
            e = rows[j]
            e[PREV] = e[GPU]
            e[GPU] = -1
            e[NEEDS_RS] = 1
            e[PREEMPTS] += 1
        for g, j in starts.items():
            e = rows[j]
            if e[START] < 0:
                e[START] = t
            if e[NEEDS_RS]:
                e[NEEDS_RS] = 0
                e[RESTARTING] = 1
            e[GPU] = g
        t += 1
        for e in rows:
            if e[GPU] >= 0:
                if e[RESTARTING]:
                    e[RESTARTING] = 0
                else:
                    e[REM] -= 1
        for e in rows:
            if e[GPU] >= 0 and e[REM] == 0:
                e[DONE] = 1
                e[END] = t
                e[FGPU] = e[GPU]
                e[GPU] = -1
        # Fast-forward when nothing is running and nothing has arrived yet.
        if not any(e[GPU] >= 0 for e in rows):
            has_waiting = any(
                not e[DONE] and problem.jobs[i].arrival <= t
                for i, e in enumerate(rows)
            )
            if not has_waiting:
                future = [
                    problem.jobs[i].arrival
                    for i, e in enumerate(rows)
                    if not e[DONE]
                ]
                if future:
                    t = min(future)
        return (t, tuple(tuple(e) for e in rows))


def greedy_schedule(engine: Engine) -> tuple:
    """Deterministic priority-driven greedy schedule (used as incumbent and
    as a fallback when the exact search exceeds its node budget)."""
    problem = engine.problem
    state = initial_state(problem)
    guard = 0
    while not engine.is_terminal(state):
        guard += 1
        if guard > 5_000_000:
            raise RuntimeError("greedy scheduler failed to converge")
        t, entries = state
        n = len(entries)
        ngpu = len(problem.gpus)
        running = [i for i in range(n) if entries[i][GPU] >= 0]
        waiting = [
            i
            for i in range(n)
            if not entries[i][DONE]
            and entries[i][GPU] < 0
            and problem.jobs[i].arrival <= t
        ]
        waiting.sort(key=lambda i: engine.prio[i])
        occupants = [
            [i for i in running if entries[i][GPU] == g] for g in range(ngpu)
        ]
        evict = set()
        starts = {}
        for w in waiting:
            placed = False
            for g in range(ngpu):
                if g in starts:
                    continue
                if engine.can_place(state, w, g, occupants[g]):
                    starts[g] = w
                    occupants[g] = occupants[g] + [w]
                    placed = True
                    break
            if placed:
                continue
            for g in range(ngpu):
                if g in starts:
                    continue
                victims = [
                    o
                    for o in occupants[g]
                    if problem.jobs[o].preemptible
                    and engine.prio[w] < engine.prio[o]
                ]
                if not victims:
                    continue
                rest = [o for o in occupants[g] if o not in victims]
                if engine.can_place(state, w, g, rest):
                    evict.update(victims)
                    occupants[g] = rest + [w]
                    starts[g] = w
                    break
        state = engine.step(state, (frozenset(evict), starts))
    return state


@dataclass(frozen=True)
class Solution:
    jobs: tuple  # tuple of dicts: id, start, end, gpu, preemptions
    objective: int


def _solution_from_state(problem: Problem, state: tuple) -> Solution:
    _, entries = state
    jobs = []
    for i, e in enumerate(entries):
        jobs.append(
            {
                "id": problem.jobs[i].id,
                "start": e[START],
                "end": e[END],
                "gpu": problem.gpus[e[FGPU]].id,
                "preemptions": e[PREEMPTS],
            }
        )
    jobs.sort(key=lambda d: id_key(d["id"]))
    return Solution(jobs=tuple(jobs), objective=sum(e[END] for e in entries))


class _BudgetExceeded(Exception):
    pass


def solve(problem: Problem, max_nodes: int = MAX_NODES):
    """Return an optimal Solution, or None if the problem is infeasible.

    Exact branch-and-bound over legal schedules; falls back to the
    deterministic greedy schedule if the node budget is exhausted.
    """
    engine = Engine(problem)
    for j in range(len(problem.jobs)):
        if not any(engine.fits[j]):
            return None

    incumbent = greedy_schedule(engine)
    best = {
        "obj": done_cost(incumbent),
        "key": tie_key(problem, incumbent),
        "state": incumbent,
    }
    memo = {}
    nodes = [0]

    def visit(state):
        t, entries = state
        acc = 0
        lower = 0
        for e in entries:
            if e[DONE]:
                acc += e[END]
            else:
                lower += t + e[REM] + (1 if (e[RESTARTING] or e[NEEDS_RS]) else 0)
        if acc + lower > best["obj"]:
            return None
        mk = memo_key(state)
        prev_acc = memo.get(mk)
        if prev_acc is not None and acc >= prev_acc:
            return None
        memo[mk] = acc
        if engine.is_terminal(state):
            key = tie_key(problem, state)
            if acc < best["obj"] or (acc == best["obj"] and key < best["key"]):
                best["obj"] = acc
                best["key"] = key
                best["state"] = state
            return None
        return [engine.step(state, action) for action in engine.actions(state)]

    # Iterative DFS with an explicit stack (no recursion depth limit).
    stack = [initial_state(problem)]
    try:
        while stack:
            if nodes[0] >= max_nodes:
                raise _BudgetExceeded()
            nodes[0] += 1
            children = visit(stack.pop())
            if children:
                stack.extend(children)
    except _BudgetExceeded:
        return _solution_from_state(problem, incumbent)
    return _solution_from_state(problem, best["state"])
