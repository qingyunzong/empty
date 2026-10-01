"""Acceptance D: for <=5 jobs and <=2 GPUs, enumerate all legal schedules
with an independent brute-force enumerator and compare the optimal
objective value against the solver's output."""

import random
import unittest
from functools import lru_cache
from itertools import combinations, product

from gpupack.model import parse_instance
from gpupack.solver import schedule

WAIT, RUN, PRE, DONE = 0, 1, 2, 3


def brute_force_objective(gpus, jobs):
    """Independent enumerator: returns the minimal sum of completion
    times over all legal schedules (no pruning, no tie-break)."""
    gpus = sorted(gpus, key=lambda g: g.id)
    jobs = sorted(jobs, key=lambda j: j.id)
    n = len(jobs)
    pkey = [(-j.arrival, j.id) for j in jobs]

    @lru_cache(maxsize=None)
    def f(t, status, work_rem, run_end, gpu, last_gpu):
        status = list(status)
        gpu = list(gpu)
        add = 0
        for i in range(n):
            if status[i] == RUN and run_end[i] == t:
                status[i] = DONE
                gpu[i] = -1
                add += t
        if all(s == DONE for s in status):
            return add
        eligible = [i for i in range(n)
                    if (status[i] == WAIT and jobs[i].arrival <= t)
                    or status[i] == PRE]
        running_on = [[] for _ in gpus]
        for i in range(n):
            if status[i] == RUN:
                running_on[gpu[i]].append(i)
        per_gpu = []
        for g in range(len(gpus)):
            opts = [None]
            for i in eligible:
                evictable = [j for j in running_on[g]
                             if jobs[j].preemptible and pkey[j] > pkey[i]]
                minimals = []
                for size in range(len(evictable) + 1):
                    for combo in combinations(evictable, size):
                        s = frozenset(combo)
                        if any(m <= s for m in minimals):
                            continue
                        rem = [j for j in running_on[g] if j not in s]
                        ok = True
                        if status[i] == PRE and last_gpu[i] == g and rem:
                            ok = False
                        if ok and not jobs[i].shareable and rem:
                            ok = False
                        if ok and jobs[i].shareable:
                            if any(not jobs[j].shareable for j in rem):
                                ok = False
                            elif sum(jobs[j].mem for j in rem) + jobs[i].mem > gpus[g].mem:
                                ok = False
                            elif sum(jobs[j].sm for j in rem) + jobs[i].sm > gpus[g].sm:
                                ok = False
                        if ok:
                            minimals.append(s)
                for s in minimals:
                    opts.append((i, s))
            per_gpu.append(opts)
        events = [run_end[i] for i in range(n) if status[i] == RUN]
        events += [jobs[i].arrival for i in range(n)
                   if status[i] == WAIT and jobs[i].arrival > t]
        best = None
        for combo in product(*per_gpu):
            starts = [(c[0], gi, c[1]) for gi, c in enumerate(combo)
                      if c is not None]
            ids = [s[0] for s in starts]
            if len(set(ids)) != len(ids):
                continue
            if not starts and eligible and not events:
                continue
            st_status = list(status)
            st_rem = list(work_rem)
            st_end = list(run_end)
            st_gpu = list(gpu)
            st_last = list(last_gpu)
            for i, g, evict in starts:
                for j in evict:
                    st_rem[j] = st_end[j] - t
                    st_status[j] = PRE
                    st_last[j] = st_gpu[j]
                    st_gpu[j] = -1
            for i, g, _ev in starts:
                restart = 1 if status[i] == PRE else 0
                st_status[i] = RUN
                st_gpu[i] = g
                st_end[i] = t + st_rem[i] + restart
            cand = [st_end[i] for i in range(n) if st_status[i] == RUN]
            cand += [jobs[i].arrival for i in range(n)
                     if st_status[i] == WAIT and jobs[i].arrival > t]
            if any((st_status[i] == WAIT and jobs[i].arrival <= t)
                   or st_status[i] == PRE for i in range(n)):
                cand.append(t + 1)
            if not cand:
                continue
            val = add + f(min(cand), tuple(st_status), tuple(st_rem),
                          tuple(st_end), tuple(st_gpu), tuple(st_last))
            if best is None or val < best:
                best = val
        return best

    t0 = min(j.arrival for j in jobs)
    return f(t0, (WAIT,) * n, tuple(j.duration for j in jobs),
             (0,) * n, (-1,) * n, (-1,) * n)


def random_instance(rng):
    m = rng.randint(1, 2)
    gpus = [{"id": f"g{k}", "mem": rng.randint(4, 8), "sm": rng.randint(4, 8)}
            for k in range(m)]
    n = rng.randint(1, 5)
    jobs = []
    for k in range(n):
        jobs.append({
            "id": f"j{k}",
            "mem": rng.randint(1, 4),
            "sm": rng.randint(1, 4),
            "shareable": rng.random() < 0.6,
            "preemptible": rng.random() < 0.4,
            "arrival": rng.randint(0, 2),
            "duration": rng.randint(1, 3),
        })
    # Keep every job feasible on at least one GPU.
    for job in jobs:
        if not any(job["mem"] <= g["mem"] and job["sm"] <= g["sm"]
                   for g in gpus):
            job["mem"] = min(job["mem"], min(g["mem"] for g in gpus))
            job["sm"] = min(job["sm"], min(g["sm"] for g in gpus))
    return {"gpus": gpus, "requests": jobs}


FIXED_INSTANCES = [
    # Preemption chain on a single GPU: each later arrival has higher
    # priority and evicts the running job.
    {
        "gpus": [{"id": "g0", "mem": 4, "sm": 4}],
        "requests": [
            {"id": "j0", "mem": 2, "sm": 2, "shareable": True,
             "preemptible": True, "arrival": 0, "duration": 3},
            {"id": "j1", "mem": 4, "sm": 4, "shareable": False,
             "preemptible": True, "arrival": 1, "duration": 2},
            {"id": "j2", "mem": 4, "sm": 4, "shareable": False,
             "preemptible": False, "arrival": 2, "duration": 1},
        ],
    },
    # Two GPUs, shareable + non-shareable mix with staggered arrivals.
    {
        "gpus": [{"id": "g0", "mem": 5, "sm": 5},
                 {"id": "g1", "mem": 6, "sm": 4}],
        "requests": [
            {"id": "j0", "mem": 3, "sm": 2, "shareable": True,
             "preemptible": True, "arrival": 0, "duration": 3},
            {"id": "j1", "mem": 2, "sm": 3, "shareable": True,
             "preemptible": False, "arrival": 0, "duration": 2},
            {"id": "j2", "mem": 5, "sm": 5, "shareable": False,
             "preemptible": False, "arrival": 1, "duration": 2},
            {"id": "j3", "mem": 1, "sm": 1, "shareable": True,
             "preemptible": True, "arrival": 2, "duration": 1},
        ],
    },
]


class TestEnumerationCrossCheck(unittest.TestCase):
    def test_random_small_instances_match_brute_force(self):
        rng = random.Random(20261001)
        for case in range(25):
            instance = random_instance(rng)
            self._check(instance, f"random {case}")

    def test_fixed_instances_match_brute_force(self):
        for case, instance in enumerate(FIXED_INSTANCES):
            self._check(instance, f"fixed {case}")

    def _check(self, instance, label):
            gpus, jobs = parse_instance(instance)
            expected = brute_force_objective(gpus, jobs)
            result = schedule(gpus, jobs)
            self.assertIsNotNone(result, f"{label}: unexpected INFEASIBLE")
            self.assertEqual(
                result["objective"], expected,
                f"{label}: objective mismatch for {instance}")
            # The reported per-job ends must sum to the objective.
            self.assertEqual(sum(j["end"] for j in result["jobs"]),
                             result["objective"])


if __name__ == "__main__":
    unittest.main()
