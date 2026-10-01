"""Solver-level tests, including the naive-backtracking reference comparison."""

import json
import unittest
from pathlib import Path

from csp_restart import ProblemError, Solver, naive_solve, problem_from_dict

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"


def load_example(name):
    with open(EXAMPLES / name, "r", encoding="utf-8") as fh:
        return problem_from_dict(json.load(fh))


class RestartScenarioTest(unittest.TestCase):
    """Acceptance scenario 1: 3-variable case needing 2 conflicts to learn
    the key nogoods; the restarted attempt must prune less than the first
    one and the final solution must match the naive reference."""

    def setUp(self):
        self.problem = load_example("three_var.json")

    def test_restart_matches_reference_and_prunes_less(self):
        reference = naive_solve(self.problem)
        self.assertEqual(reference, {"x": 2, "y": 1, "z": 4})

        solver = Solver(self.problem, restart_threshold=2, total_budget=1000)
        status = solver.solve()

        self.assertEqual(status, "sat")
        self.assertEqual(solver.solution, reference)
        self.assertEqual(solver.restart_count, 1)
        # Two conflicts in the first attempt produce the two key nogoods.
        self.assertEqual(solver.attempts[0]["conflicts"], 2)
        self.assertIn({"x": 1, "y": 1}, solver.nogoods)
        self.assertIn({"x": 1, "y": 2}, solver.nogoods)
        # The restarted attempt prunes fewer values than the first attempt.
        self.assertLess(solver.attempts[1]["prunes"], solver.attempts[0]["prunes"])

    def test_without_restart_same_solution(self):
        solver = Solver(self.problem, restart_threshold=10**9, total_budget=1000)
        self.assertEqual(solver.solve(), "sat")
        self.assertEqual(solver.solution, naive_solve(self.problem))
        self.assertEqual(solver.restart_count, 0)


class ThresholdOneTest(unittest.TestCase):
    """Acceptance scenario 2: threshold 1 restarts right after the first
    conflict, keeps exactly 1 nogood and resets the decision level to 0."""

    def setUp(self):
        self.problem = load_example("two_var_restart.json")

    def test_first_conflict_triggers_single_restart(self):
        snapshots = []
        solver = Solver(
            self.problem,
            restart_threshold=1,
            total_budget=1000,
            on_restart=lambda s: snapshots.append(
                (s.restart_count, len(s.nogoods), s.level, s.decisions)
            ),
        )
        status = solver.solve()

        self.assertEqual(status, "sat")
        self.assertEqual(solver.solution, naive_solve(self.problem))
        # State observed immediately after the first restart.
        self.assertEqual(snapshots[0], (1, 1, 0, 0))
        self.assertEqual(len(snapshots), 1)
        # Final state: one restart, one retained nogood.
        self.assertEqual(solver.restart_count, 1)
        self.assertEqual(solver.nogoods, [{"x": 1}])


class BudgetAndUnsatTest(unittest.TestCase):
    """Acceptance scenarios 3 and 4."""

    def test_zero_budget_without_initial_contradiction_is_timeout(self):
        problem = load_example("two_var_restart.json")
        solver = Solver(problem, restart_threshold=1, total_budget=0)
        self.assertEqual(solver.solve(), "timeout")
        self.assertIsNone(solver.solution)
        self.assertEqual(solver.restart_count, 0)
        self.assertEqual(solver.nogoods, [])

    def test_initial_propagation_contradiction_is_unsat_without_restart(self):
        problem = load_example("root_unsat.json")
        solver = Solver(problem, restart_threshold=1, total_budget=1000)
        self.assertEqual(solver.solve(), "unsat")
        self.assertEqual(solver.restart_count, 0)
        self.assertEqual(solver.nogoods, [])

    def test_budget_exhaustion_is_timeout_not_unsat(self):
        # The problem is unsat, but proving it needs 2 conflicts.
        problem = load_example("empty_table.json")
        limited = Solver(problem, restart_threshold=100, total_budget=1)
        self.assertEqual(limited.solve(), "timeout")
        self.assertIsNone(limited.solution)

        unlimited = Solver(problem, restart_threshold=100, total_budget=100)
        self.assertEqual(unlimited.solve(), "unsat")
        self.assertIsNone(unlimited.solution)

    def test_threshold_zero_restarts_on_every_conflict(self):
        problem = load_example("two_var_restart.json")
        solver = Solver(problem, restart_threshold=0, total_budget=1000)
        self.assertEqual(solver.solve(), "sat")
        self.assertEqual(solver.restart_count, solver.total_conflicts)
        self.assertGreater(solver.restart_count, 0)


class ReferenceComparisonTest(unittest.TestCase):
    """The restarting solver must agree with naive backtracking."""

    def test_all_different_sat(self):
        problem = problem_from_dict({
            "variables": [
                {"name": "a", "domain": [1, 2, 3]},
                {"name": "b", "domain": [1, 2, 3]},
                {"name": "c", "domain": [1, 2, 3]},
            ],
            "constraints": [
                {"type": "all_different", "vars": ["a", "b", "c"]},
                {"type": "neq", "vars": ["a", "c"]},
            ],
        })
        solver = Solver(problem, restart_threshold=2, total_budget=1000)
        self.assertEqual(solver.solve(), "sat")
        self.assertEqual(solver.solution, naive_solve(problem))

    def test_all_different_unsat(self):
        problem = problem_from_dict({
            "variables": [
                {"name": "a", "domain": [1, 2]},
                {"name": "b", "domain": [1, 2]},
                {"name": "c", "domain": [1, 2]},
            ],
            "constraints": [{"type": "all_different", "vars": ["a", "b", "c"]}],
        })
        self.assertIsNone(naive_solve(problem))
        solver = Solver(problem, restart_threshold=1, total_budget=1000)
        self.assertEqual(solver.solve(), "unsat")

    def test_eq_constraint(self):
        problem = problem_from_dict({
            "variables": [
                {"name": "a", "domain": [1, 2]},
                {"name": "b", "domain": [2, 3]},
            ],
            "constraints": [{"type": "eq", "vars": ["a", "b"]}],
        })
        solver = Solver(problem, restart_threshold=1, total_budget=100)
        self.assertEqual(solver.solve(), "sat")
        self.assertEqual(solver.solution, {"a": 2, "b": 2})
        self.assertEqual(solver.solution, naive_solve(problem))


class ValidationTest(unittest.TestCase):
    def test_negative_parameters_raise(self):
        problem = load_example("two_var_restart.json")
        with self.assertRaises(ValueError):
            Solver(problem, restart_threshold=-1, total_budget=0)
        with self.assertRaises(ValueError):
            Solver(problem, restart_threshold=0, total_budget=-1)

    def test_invalid_problem_definitions(self):
        base = {
            "variables": [{"name": "x", "domain": [1]}],
            "constraints": [],
        }
        bad_cases = [
            None,
            [],
            {"variables": []},
            {"variables": [], "constraints": []},
            {"variables": [{"name": "x"}], "constraints": []},
            {"variables": [{"name": "x", "domain": []}], "constraints": []},
            {"variables": [{"name": "x", "domain": [1]},
                           {"name": "x", "domain": [2]}], "constraints": []},
            {**base, "constraints": [{"type": "bogus", "vars": ["x"]}]},
            {**base, "constraints": [{"type": "neq", "vars": ["x", "y"]}]},
            {**base, "constraints": [{"type": "neq", "vars": ["x"]}]},
            {**base, "constraints": [{"type": "table", "vars": ["x"]}]},
            {**base, "constraints": [
                {"type": "table", "vars": ["x"], "allowed": [[1, 2]]}]},
        ]
        for data in bad_cases:
            with self.assertRaises(ProblemError, msg=repr(data)):
                problem_from_dict(data)


if __name__ == "__main__":
    unittest.main()
