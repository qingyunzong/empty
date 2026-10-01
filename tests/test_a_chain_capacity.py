"""Acceptance A: dependency chain and single-machine capacity boundary."""
import unittest

from rostersolve import model, solver
from rostersolve.brute import validate_schedule


def make(jobs, machines, horizon):
    return model.load_instance(
        {"jobs": jobs, "machines": machines, "horizon": horizon})


class TestChainAndCapacity(unittest.TestCase):
    def test_dependency_chain_single_machine(self):
        jobs, machines, horizon = make(
            [
                {"id": "j1", "cpu": 2, "mem": 1, "deadline": 6,
                 "duration": 2, "deps": [], "tags": []},
                {"id": "j2", "cpu": 2, "mem": 1, "deadline": 6,
                 "duration": 2, "deps": ["j1"], "tags": []},
            ],
            [{"id": "m1", "cpu": 2, "mem": 2, "tags": []}],
            6,
        )
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNotNone(assign)
        self.assertTrue(validate_schedule(jobs, machines, horizon, assign))
        s1 = assign["j1"][1]
        s2 = assign["j2"][1]
        self.assertGreaterEqual(s2, s1 + 2)
        makespan = max(s1, s2) + 2
        self.assertEqual(makespan, 4)

    def test_capacity_boundary_exact_fit(self):
        jobs, machines, horizon = make(
            [{"id": "j1", "cpu": 4, "mem": 3, "deadline": 2,
              "duration": 2, "deps": [], "tags": []}],
            [{"id": "m1", "cpu": 4, "mem": 3, "tags": []}],
            2,
        )
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNotNone(assign)
        self.assertEqual(assign["j1"], ("m1", 0))

    def test_capacity_exceeded_by_one_infeasible(self):
        jobs, machines, horizon = make(
            [{"id": "j1", "cpu": 5, "mem": 3, "deadline": 2,
              "duration": 2, "deps": [], "tags": []}],
            [{"id": "m1", "cpu": 4, "mem": 3, "tags": []}],
            2,
        )
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNone(assign)
        conflict = solver.minimal_conflict(jobs, machines, horizon)
        self.assertEqual(conflict, ["j1"])

    def test_capacity_forces_serialization(self):
        jobs, machines, horizon = make(
            [
                {"id": "a", "cpu": 3, "mem": 1, "deadline": 2,
                 "duration": 1, "deps": [], "tags": []},
                {"id": "b", "cpu": 3, "mem": 1, "deadline": 2,
                 "duration": 1, "deps": [], "tags": []},
            ],
            [{"id": "m1", "cpu": 5, "mem": 2, "tags": []}],
            2,
        )
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNotNone(assign)
        self.assertNotEqual(assign["a"][1], assign["b"][1])
        # horizon 1 cannot serialize two jobs -> infeasible
        jobs, machines, horizon = make(
            [
                {"id": "a", "cpu": 3, "mem": 1, "deadline": 1,
                 "duration": 1, "deps": [], "tags": []},
                {"id": "b", "cpu": 3, "mem": 1, "deadline": 1,
                 "duration": 1, "deps": [], "tags": []},
            ],
            [{"id": "m1", "cpu": 5, "mem": 2, "tags": []}],
            1,
        )
        assign, _ = solver.solve(jobs, machines, horizon)
        self.assertIsNone(assign)


if __name__ == "__main__":
    unittest.main()
