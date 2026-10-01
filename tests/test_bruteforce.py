"""Acceptance test D: for <=5 jobs and <=2 GPUs, enumerate all legal
schedules with an independent exhaustive search and compare objectives."""
import random
import unittest

from gpupack.model import parse_problem
from gpupack.scheduler import (
    DONE,
    END,
    NEEDS_RS,
    REM,
    RESTARTING,
    Engine,
    greedy_schedule,
    initial_state,
    memo_key,
    solve,
)


def brute_force_objective(problem):
    """Exhaustive enumeration of every legal schedule (with dominance
    memoization only). Returns the minimal sum of completion times."""
    engine = Engine(problem)
    for j in range(len(problem.jobs)):
        if not any(engine.fits[j]):
            return None
    best = [sum(e[END] for e in greedy_schedule(engine)[1])]
    memo = {}

    def visit(state):
        t, entries = state
        acc = 0
        lower = 0
        for e in entries:
            if e[DONE]:
                acc += e[END]
            else:
                lower += t + e[REM] + (1 if (e[RESTARTING] or e[NEEDS_RS]) else 0)
        if acc + lower >= best[0]:
            return None
        mk = memo_key(state)
        seen = memo.get(mk)
        if seen is not None and seen <= acc:
            return None
        memo[mk] = acc
        if all(e[DONE] for e in entries):
            best[0] = acc
            return None
        return [engine.step(state, a) for a in engine.actions(state)]

    stack = [initial_state(problem)]
    while stack:
        children = visit(stack.pop())
        if children:
            stack.extend(children)
    return best[0]


def random_instance(rng):
    ngpu = rng.randint(1, 2)
    gpus = [
        {"id": f"g{g}", "mem": rng.randint(4, 10), "sm": rng.randint(4, 10)}
        for g in range(ngpu)
    ]
    reqs = []
    for i in range(rng.randint(1, 5)):
        g = rng.randrange(ngpu)  # guarantee the job fits at least one GPU
        reqs.append(
            {
                "id": f"j{i}",
                "mem": rng.randint(1, gpus[g]["mem"]),
                "sm": rng.randint(1, gpus[g]["sm"]),
                "shareable": rng.random() < 0.5,
                "preemptible": rng.random() < 0.5,
                "arrival": rng.randint(0, 4),
                "duration": rng.randint(1, 6),
            }
        )
    return {"gpus": gpus, "requests": reqs}


class TestDBruteForce(unittest.TestCase):
    def check(self, spec):
        problem = parse_problem(spec)
        sol = solve(problem)
        expected = brute_force_objective(problem)
        if expected is None:
            self.assertIsNone(sol)
            return
        self.assertIsNotNone(sol)
        self.assertEqual(sol.objective, expected)
        # Internal consistency: objective is the sum of completion times.
        self.assertEqual(sum(j["end"] for j in sol.jobs), expected)

    def test_random_instances(self):
        rng = random.Random(20261001)
        for case in range(25):
            with self.subTest(case=case):
                self.check(random_instance(rng))

    def test_handcrafted_instances(self):
        instances = [
            # Preemption-heavy: three arrivals, one GPU.
            {
                "gpus": [{"id": "g0", "mem": 8, "sm": 8}],
                "requests": [
                    {"id": "a", "mem": 8, "sm": 8, "shareable": False,
                     "preemptible": True, "arrival": 0, "duration": 6},
                    {"id": "b", "mem": 8, "sm": 8, "shareable": False,
                     "preemptible": True, "arrival": 2, "duration": 4},
                    {"id": "c", "mem": 8, "sm": 8, "shareable": False,
                     "preemptible": False, "arrival": 4, "duration": 2},
                ],
            },
            # Shareable packing mixed with a non-shareable job, two GPUs.
            {
                "gpus": [
                    {"id": "g0", "mem": 6, "sm": 6},
                    {"id": "g1", "mem": 10, "sm": 10},
                ],
                "requests": [
                    {"id": "s1", "mem": 3, "sm": 3, "shareable": True,
                     "preemptible": True, "arrival": 0, "duration": 5},
                    {"id": "s2", "mem": 3, "sm": 3, "shareable": True,
                     "preemptible": False, "arrival": 1, "duration": 3},
                    {"id": "x", "mem": 10, "sm": 10, "shareable": False,
                     "preemptible": False, "arrival": 2, "duration": 4},
                    {"id": "s3", "mem": 2, "sm": 2, "shareable": True,
                     "preemptible": True, "arrival": 3, "duration": 2},
                ],
            },
            # Staggered arrivals forcing idle-time decisions.
            {
                "gpus": [{"id": "g0", "mem": 5, "sm": 5}],
                "requests": [
                    {"id": "p", "mem": 5, "sm": 5, "shareable": False,
                     "preemptible": False, "arrival": 0, "duration": 2},
                    {"id": "q", "mem": 5, "sm": 5, "shareable": False,
                     "preemptible": False, "arrival": 1, "duration": 5},
                    {"id": "r", "mem": 5, "sm": 5, "shareable": False,
                     "preemptible": True, "arrival": 2, "duration": 1},
                ],
            },
        ]
        for i, spec in enumerate(instances):
            with self.subTest(handcrafted=i):
                self.check(spec)


if __name__ == "__main__":
    unittest.main()
