"""Acceptance C: random small instances (n<=8, horizon<=12) cross-checked
against the in-repo brute-force enumerator."""
import random
import unittest

from rostersolve import model, solver
from rostersolve.brute import (
    BruteForceLimit,
    brute_force_feasible,
    validate_schedule,
)

TAG_POOL = ["a", "b", "c"]


def gen_instance(rng):
    n = rng.randint(1, 8)
    m = rng.randint(1, 3)
    horizon = rng.randint(1, 12)
    machines = []
    for i in range(m):
        machines.append({
            "id": f"m{i}",
            "cpu": rng.randint(1, 5),
            "mem": rng.randint(1, 5),
            "tags": sorted(t for t in TAG_POOL if rng.random() < 0.6),
        })
    jobs = []
    for i in range(n):
        duration = rng.randint(1, min(4, horizon))
        jobs.append({
            "id": f"j{i}",
            "cpu": rng.randint(0, 4),
            "mem": rng.randint(0, 4),
            "deadline": rng.randint(duration, horizon + 2),
            "duration": duration,
            "deps": [f"j{k}" for k in range(i) if rng.random() < 0.3],
            "tags": sorted(t for t in TAG_POOL if rng.random() < 0.4),
        })
    return {"jobs": jobs, "machines": machines, "horizon": horizon}


class TestRandomCrossCheck(unittest.TestCase):
    def test_random_instances_match_brute_force(self):
        rng = random.Random(20261001)
        checked = 0
        feasible_count = 0
        attempts = 0
        while checked < 60 and attempts < 600:
            attempts += 1
            data = gen_instance(rng)
            jobs, machines, horizon = model.load_instance(data)
            try:
                brute = brute_force_feasible(jobs, machines, horizon)
            except BruteForceLimit:
                continue
            assign, _ = solver.solve(jobs, machines, horizon)
            self.assertEqual(
                assign is not None, brute,
                f"verdict mismatch on {data!r}")
            if assign is not None:
                feasible_count += 1
                self.assertTrue(
                    validate_schedule(jobs, machines, horizon, assign),
                    f"invalid solver schedule on {data!r}")
            else:
                conflict = solver.minimal_conflict(jobs, machines, horizon)
                self.assertTrue(conflict)
            checked += 1
        self.assertEqual(checked, 60, "could not generate enough instances")
        # sanity: the sample must contain both feasible and infeasible cases
        self.assertGreater(feasible_count, 0)
        self.assertGreater(checked - feasible_count, 0)


if __name__ == "__main__":
    unittest.main()
