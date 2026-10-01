"""Exact discrete-time GPU scheduler.

Semantics implemented here (see README.md for the full specification):

* Time is discrete (integer ticks). A job started at tick ``t`` with run
  length ``L`` occupies ticks ``t .. t+L-1`` and completes at tick ``t+L``.
* A non-shareable job occupies a whole GPU exclusively. Shareable jobs may
  coexist on one GPU as long as the summed ``mem``/``sm`` stay within the
  GPU capacity.
* Priority key is ``(-arrival, id)``; the *smaller* key wins (a later
  arrival means a higher priority). Only jobs with ``preemptible=True``
  may be evicted, and only by a strictly higher-priority job that is being
  started on the same GPU and would not fit otherwise.
* An evicted job keeps its remaining work. Restarting it costs 1 extra
  tick (its next run length is ``remaining + 1``) and it may not return to
  its previous GPU while that GPU is still occupied. An evicted job may
  restart at the earliest on the tick after its eviction.
* Per GPU and tick: at most 1 start, any number of completions and
  evictions.
* Objective: minimise the sum of completion times. Ties are broken by the
  lexicographically smallest sequence of per-job records
  ``(start, end, gpu, preemptions)`` with jobs ordered by ``id``.

The solver is an exact depth-first search over decision epochs with
branch-and-bound and memoisation; it is fully deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations, product

WAIT, RUN, PRE, DONE = 0, 1, 2, 3

MAX_NODES = 2_000_000


@dataclass(frozen=True)
class Gpu:
    id: object
    mem: int
    sm: int


@dataclass(frozen=True)
class Job:
    id: object
    mem: int
    sm: int
    shareable: bool
    preemptible: bool
    arrival: int
    duration: int


class _State:
    __slots__ = (
        "status", "work_rem", "run_end", "gpu", "last_gpu",
        "first_start", "final_gpu", "preemptions", "end",
    )

    def __init__(self, n):
        self.status = [WAIT] * n
        self.work_rem = [0] * n
        self.run_end = [0] * n
        self.gpu = [-1] * n
        self.last_gpu = [-1] * n
        self.first_start = [-1] * n
        self.final_gpu = [-1] * n
        self.preemptions = [0] * n
        self.end = [-1] * n

    def copy(self):
        clone = _State.__new__(_State)
        for name in self.__slots__:
            setattr(clone, name, list(getattr(self, name)))
        return clone


class Solver:
    def __init__(self, gpus, jobs):
        self.gpus = sorted(gpus, key=lambda g: g.id)
        self.jobs = sorted(jobs, key=lambda j: j.id)
        # Smaller key == higher priority.
        self.pkey = [(-j.arrival, j.id) for j in self.jobs]
        self.best_obj = None
        self.best_key = None
        self.best_state = None
        self.memo = {}
        self.nodes = 0

    # -- public ---------------------------------------------------------
    def solve(self):
        n = len(self.jobs)
        if n == 0:
            self.best_state = _State(0)
            return self.best_state
        st = _State(n)
        for i, job in enumerate(self.jobs):
            st.work_rem[i] = job.duration
        self._epoch(min(job.arrival for job in self.jobs), st, 0)
        return self.best_state

    def records(self):
        st = self.best_state
        if st is None:
            return None
        out = []
        for i, job in enumerate(self.jobs):
            out.append({
                "id": job.id,
                "start": st.first_start[i],
                "end": st.end[i],
                "gpu": self.gpus[st.final_gpu[i]].id,
                "preemptions": st.preemptions[i],
            })
        return out

    # -- search ---------------------------------------------------------
    def _epoch(self, t, st, cost):
        self.nodes += 1
        if self.nodes > MAX_NODES:
            return
        n = len(self.jobs)
        # 1. completions (any number per GPU per tick)
        for i in range(n):
            if st.status[i] == RUN and st.run_end[i] == t:
                st.status[i] = DONE
                st.end[i] = t
                st.final_gpu[i] = st.gpu[i]
                st.gpu[i] = -1
                cost += t
        # 2. leaf
        if all(st.status[i] == DONE for i in range(n)):
            key = tuple(
                (st.first_start[i], st.end[i],
                 self.gpus[st.final_gpu[i]].id, st.preemptions[i])
                for i in range(n)
            )
            if self.best_obj is None or (cost, key) < (self.best_obj, self.best_key):
                self.best_obj = cost
                self.best_key = key
                self.best_state = st.copy()
            return
        # 3. branch-and-bound lower bound
        lb = cost
        for i in range(n):
            if st.status[i] == RUN:
                lb += st.run_end[i]
            elif st.status[i] != DONE:
                lb += t + st.work_rem[i] + (1 if st.status[i] == PRE else 0)
        if self.best_obj is not None and lb > self.best_obj:
            return
        # 4. memoisation (strictly better cost prunes; equal cost is kept
        #    so the tie-break stays exact)
        mkey = (t, tuple(st.status), tuple(st.work_rem), tuple(st.run_end),
                tuple(st.gpu), tuple(st.last_gpu))
        prev = self.memo.get(mkey)
        if prev is not None and prev < cost:
            return
        self.memo[mkey] = cost if prev is None else min(prev, cost)
        # 5. generate actions
        running_on = [[] for _ in self.gpus]
        for i in range(n):
            if st.status[i] == RUN:
                running_on[st.gpu[i]].append(i)
        eligible = [i for i in range(n)
                    if (st.status[i] == WAIT and self.jobs[i].arrival <= t)
                    or st.status[i] == PRE]
        per_gpu = []
        for g in range(len(self.gpus)):
            opts = [None]
            for i in eligible:
                for evict in self._eviction_options(i, g, st, running_on[g]):
                    opts.append((i, evict))
            per_gpu.append(opts)
        actions = []
        for combo in product(*per_gpu):
            starts = [(c[0], gi, c[1]) for gi, c in enumerate(combo) if c is not None]
            ids = [s[0] for s in starts]
            if len(set(ids)) != len(ids):
                continue
            actions.append(starts)
        actions.sort(key=lambda a: (
            -len(a), tuple(sorted((self.pkey[i], g) for i, g, _ in a))))
        events = [st.run_end[i] for i in range(n) if st.status[i] == RUN]
        events += [self.jobs[i].arrival for i in range(n)
                   if st.status[i] == WAIT and self.jobs[i].arrival > t]
        for starts in actions:
            if not starts and eligible and not events:
                # Nothing running, nothing arriving: idling can never
                # terminate, so a start is mandatory here.
                continue
            st2 = st.copy()
            for i, g, evict in starts:
                for j in evict:
                    st2.work_rem[j] = st2.run_end[j] - t
                    st2.status[j] = PRE
                    st2.last_gpu[j] = st2.gpu[j]
                    st2.gpu[j] = -1
                    st2.preemptions[j] += 1
            for i, g, _evict in starts:
                restart = 1 if st.status[i] == PRE else 0
                st2.status[i] = RUN
                st2.gpu[i] = g
                st2.run_end[i] = t + st2.work_rem[i] + restart
                if st2.first_start[i] < 0:
                    st2.first_start[i] = t
            cand = [st2.run_end[i] for i in range(n) if st2.status[i] == RUN]
            cand += [self.jobs[i].arrival for i in range(n)
                     if st2.status[i] == WAIT and self.jobs[i].arrival > t]
            pending = any(
                (st2.status[i] == WAIT and self.jobs[i].arrival <= t)
                or st2.status[i] == PRE for i in range(n))
            if pending:
                cand.append(t + 1)
            if not cand:
                continue
            self._epoch(min(cand), st2, cost)

    def _eviction_options(self, i, g, st, run_g):
        """Minimal (by inclusion) eviction sets letting job ``i`` start on
        GPU ``g`` this tick. Every evicted job must be preemptible and of
        strictly lower priority than ``i``."""
        job = self.jobs[i]
        gpu = self.gpus[g]
        pki = self.pkey[i]
        evictable = [j for j in run_g
                     if self.jobs[j].preemptible and self.pkey[j] > pki]

        def fits(evict_set):
            rem = [j for j in run_g if j not in evict_set]
            if st.status[i] == PRE and st.last_gpu[i] == g and rem:
                return False  # may not return to an occupied original GPU
            if not job.shareable:
                return not rem
            if any(not self.jobs[j].shareable for j in rem):
                return False
            return (sum(self.jobs[j].mem for j in rem) + job.mem <= gpu.mem
                    and sum(self.jobs[j].sm for j in rem) + job.sm <= gpu.sm)

        out = []
        for size in range(len(evictable) + 1):
            for combo in combinations(evictable, size):
                s = frozenset(combo)
                if any(m <= s for m in out):
                    continue
                if fits(s):
                    out.append(s)
        return out


def schedule(gpus, jobs):
    """Return the result payload dict, or ``None`` if infeasible."""
    for job in jobs:
        if not any(job.mem <= g.mem and job.sm <= g.sm for g in gpus):
            return None
    solver = Solver(gpus, jobs)
    records = solver.records() if solver.solve() is not None else None
    if records is None:
        return None
    return {
        "status": "OK",
        "objective": sum(r["end"] for r in records),
        "jobs": records,
    }
