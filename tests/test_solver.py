import unittest

from csp_restart import ProblemError, Solver, load_problem, naive_solve


def scenario_one_problem():
    """3 variables; x=1 fails through 2 conflicts (y=1 and y=2), which
    derive the nogoods that prune the whole x=1 branch after a restart."""
    return load_problem(
        {
            "variables": [
                {"name": "x", "domain": [1, 2]},
                {"name": "y", "domain": [1, 2]},
                {"name": "z", "domain": [1, 2]},
            ],
            "constraints": [
                {"type": "table", "vars": ["x", "z"], "allowed": [[1, 1], [2, 2]]},
                {"type": "table", "vars": ["y", "z"], "allowed": [[1, 2], [2, 2]]},
            ],
        }
    )


def scenario_two_problem():
    """Level-0 propagation fixes y=2; x=1 then conflicts, yielding the
    single nogood {x=1} that solves the problem after one restart."""
    return load_problem(
        {
            "variables": [
                {"name": "x", "domain": [1, 2]},
                {"name": "y", "domain": [1, 2]},
            ],
            "constraints": [
                {"type": "linear", "vars": ["y"], "coeffs": [1], "op": ">=", "value": 2},
                {"type": "table", "vars": ["x", "y"], "allowed": [[2, 2], [1, 1]]},
            ],
        }
    )


class ScenarioOneTest(unittest.TestCase):
    def test_restart_prunes_more_and_matches_naive_reference(self):
        problem = scenario_one_problem()
        solver = Solver(problem, restart_threshold=2, total_budget=100)
        result = solver.solve()
        self.assertEqual(result.status, "sat")
        self.assertEqual(result.solution, naive_solve(problem))
        self.assertEqual(result.solution, {"x": 2, "y": 1, "z": 2})
        self.assertEqual(result.restart_count, 1)
        self.assertEqual(len(solver.run_stats), 2)
        first_run, second_run = solver.run_stats
        self.assertEqual(first_run["conflicts"], 2)
        self.assertLess(second_run["conflicts"], first_run["conflicts"])
        self.assertGreater(second_run["nogood_prunes"], 0)
        nogood_set = {frozenset(map(tuple, ng)) for ng in result.nogoods}
        self.assertIn(frozenset({("x", 1), ("y", 1)}), nogood_set)
        self.assertIn(frozenset({("x", 1), ("y", 2)}), nogood_set)


class ScenarioTwoTest(unittest.TestCase):
    def test_threshold_one_triggers_single_restart(self):
        problem = scenario_two_problem()
        solver = Solver(problem, restart_threshold=1, total_budget=100)
        result = solver.solve()
        self.assertEqual(result.status, "sat")
        self.assertEqual(result.solution, {"x": 2, "y": 2})
        self.assertEqual(result.solution, naive_solve(problem))
        self.assertEqual(result.restart_count, 1)
        self.assertEqual(len(result.nogoods), 1)
        self.assertEqual(result.nogoods[0], [("x", 1)])
        self.assertEqual(len(solver.restart_snapshots), 1)
        snapshot = solver.restart_snapshots[0]
        self.assertEqual(snapshot["decisions_after_reset"], 0)
        self.assertGreater(snapshot["decisions_before_reset"], 0)
        self.assertEqual(snapshot["nogoods_retained"], 1)


class ScenarioThreeTest(unittest.TestCase):
    def test_zero_budget_without_initial_contradiction_is_timeout(self):
        problem = load_problem(
            {
                "variables": [{"name": "x", "domain": [1, 2]}],
                "constraints": [],
            }
        )
        result = Solver(problem, restart_threshold=1, total_budget=0).solve()
        self.assertEqual(result.status, "timeout")
        self.assertIsNone(result.solution)
        self.assertEqual(result.restart_count, 0)


class ScenarioFourTest(unittest.TestCase):
    def test_initial_propagation_conflict_is_unsat_without_restart(self):
        problem = load_problem(
            {
                "variables": [{"name": "x", "domain": [1, 2]}],
                "constraints": [
                    {
                        "type": "linear",
                        "vars": ["x"],
                        "coeffs": [1],
                        "op": ">=",
                        "value": 5,
                    }
                ],
            }
        )
        solver = Solver(problem, restart_threshold=1, total_budget=100)
        result = solver.solve()
        self.assertEqual(result.status, "unsat")
        self.assertIsNone(result.solution)
        self.assertEqual(result.restart_count, 0)
        self.assertEqual(result.nogoods, [])


class TimeoutTest(unittest.TestCase):
    def test_budget_exhaustion_is_timeout_not_unsat(self):
        problem = scenario_two_problem()
        solver = Solver(problem, restart_threshold=5, total_budget=1)
        result = solver.solve()
        self.assertEqual(result.status, "timeout")
        self.assertIsNone(result.solution)
        self.assertEqual(result.restart_count, 0)
        self.assertEqual(solver.conflicts_total, 1)


class UnsatAfterRestartsTest(unittest.TestCase):
    def test_root_contradiction_after_restarts_is_unsat(self):
        problem = load_problem(
            {
                "variables": [
                    {"name": "x", "domain": [1, 2]},
                    {"name": "y", "domain": [1, 2]},
                ],
                "constraints": [
                    {"type": "table", "vars": ["x", "y"], "allowed": []},
                ],
            }
        )
        solver = Solver(problem, restart_threshold=1, total_budget=50)
        result = solver.solve()
        self.assertEqual(result.status, "unsat")
        self.assertEqual(result.restart_count, 2)
        nogood_set = {frozenset(map(tuple, ng)) for ng in result.nogoods}
        self.assertIn(frozenset({("x", 1)}), nogood_set)
        self.assertIn(frozenset({("x", 2)}), nogood_set)


class NaiveReferenceTest(unittest.TestCase):
    def test_matches_naive_backtracking_without_restarts(self):
        problem = load_problem(
            {
                "variables": [
                    {"name": name, "domain": [1, 2, 3]} for name in ("a", "b", "c")
                ],
                "constraints": [
                    {"type": "all_different", "vars": ["a", "b", "c"]},
                    {
                        "type": "linear",
                        "vars": ["a", "b", "c"],
                        "coeffs": [1, 1, 1],
                        "op": ">=",
                        "value": 6,
                    },
                    {"type": "neq", "vars": ["a", "c"]},
                ],
            }
        )
        solver = Solver(problem, restart_threshold=10**9, total_budget=10**6)
        result = solver.solve()
        self.assertEqual(result.status, "sat")
        self.assertEqual(result.restart_count, 0)
        self.assertEqual(result.solution, naive_solve(problem))
        self.assertEqual(result.solution, {"a": 1, "b": 2, "c": 3})

    def test_matches_naive_backtracking_with_restarts(self):
        problem = scenario_one_problem()
        solver = Solver(problem, restart_threshold=2, total_budget=100)
        result = solver.solve()
        self.assertEqual(result.solution, naive_solve(problem))


class ValidationTest(unittest.TestCase):
    def _invalid(self, payload):
        with self.assertRaises(ProblemError):
            load_problem(payload)

    def test_rejects_non_object_problem(self):
        self._invalid([1, 2, 3])

    def test_rejects_empty_variables(self):
        self._invalid({"variables": [], "constraints": []})

    def test_rejects_duplicate_variable_names(self):
        self._invalid(
            {
                "variables": [
                    {"name": "x", "domain": [1]},
                    {"name": "x", "domain": [2]},
                ]
            }
        )

    def test_rejects_unknown_variable_in_constraint(self):
        self._invalid(
            {
                "variables": [{"name": "x", "domain": [1]}],
                "constraints": [{"type": "eq", "vars": ["x", "y"]}],
            }
        )

    def test_rejects_unknown_constraint_type(self):
        self._invalid(
            {
                "variables": [{"name": "x", "domain": [1]}],
                "constraints": [{"type": "magic", "vars": ["x"]}],
            }
        )

    def test_rejects_bad_table_row(self):
        self._invalid(
            {
                "variables": [{"name": "x", "domain": [1]}],
                "constraints": [
                    {"type": "table", "vars": ["x"], "allowed": [[1, 2]]}
                ],
            }
        )

    def test_rejects_bad_linear_operator(self):
        self._invalid(
            {
                "variables": [{"name": "x", "domain": [1]}],
                "constraints": [
                    {
                        "type": "linear",
                        "vars": ["x"],
                        "coeffs": [1],
                        "op": "??",
                        "value": 1,
                    }
                ],
            }
        )

    def test_solver_rejects_negative_parameters(self):
        problem = load_problem(
            {"variables": [{"name": "x", "domain": [1]}], "constraints": []}
        )
        with self.assertRaises(ValueError):
            Solver(problem, restart_threshold=-1, total_budget=0)
        with self.assertRaises(ValueError):
            Solver(problem, restart_threshold=0, total_budget=-1)


if __name__ == "__main__":
    unittest.main()
