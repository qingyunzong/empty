import json
import os
import subprocess
import sys
import tempfile
import unittest

from csp_budget import COMPLETE, TIMEOUT, UNSAT, InputError, propagate
from tests.reference_ac3 import count_checks, run_ac3, truncate_at_check


CHAIN_PROBLEM = (
    {"x": [1, 2, 3], "y": [1, 2, 3], "z": [1, 2, 3]},
    [
        {"var1": "x", "var2": "y", "allowed": [[1, 2], [2, 3], [3, 1]]},
        {"var1": "y", "var2": "z", "allowed": [[1, 1], [2, 2], [3, 3]]},
    ],
)

THREE_CHECK_PROBLEM = (
    {"x": [1, 2], "y": [1, 2]},
    [{"var1": "x", "var2": "y", "allowed": [[1, 1]]}],
)


class TestCompleteRunsMatchReference(unittest.TestCase):
    """Scenario 1: with ample budget the budgeted run matches the logged
    reference AC-3 exactly, including the number of match checks."""

    def assert_matches_reference(self, variables, constraints):
        ref_status, ref_domains, log = run_ac3(variables, constraints)
        result = propagate(variables, constraints, 10**9)
        self.assertEqual(result["status"], ref_status)
        self.assertEqual(result["domains"], ref_domains)
        self.assertEqual(result["used_budget"], count_checks(log))

    def test_chain_problem(self):
        self.assert_matches_reference(*CHAIN_PROBLEM)

    def test_triangle_problem(self):
        variables = {"a": [1, 2, 3], "b": [1, 2, 3], "c": [1, 2, 3]}
        constraints = [
            {"var1": "a", "var2": "b", "allowed": [[1, 2], [2, 3], [3, 1]]},
            {"var1": "b", "var2": "c", "allowed": [[1, 3], [2, 1], [3, 2]]},
            {"var1": "a", "var2": "c", "allowed": [[1, 1], [2, 2], [3, 3]]},
        ]
        self.assert_matches_reference(variables, constraints)

    def test_unsatisfiable_problem(self):
        variables = {"x": [1], "y": [2]}
        constraints = [{"var1": "x", "var2": "y", "allowed": [[1, 1]]}]
        self.assert_matches_reference(variables, constraints)
        result = propagate(variables, constraints, 10**9)
        self.assertEqual(result["status"], UNSAT)
        self.assertEqual(result["domains"]["x"], [])

    def test_no_constraints(self):
        variables = {"x": [1, 2], "y": [3]}
        self.assert_matches_reference(variables, [])
        result = propagate(variables, [], 10**9)
        self.assertEqual(result["status"], COMPLETE)
        self.assertEqual(result["used_budget"], 0)


class TestBudgetTruncation(unittest.TestCase):
    """Scenario 2: a budget equal to the first N match checks stops the
    propagation at exactly that point with status timeout."""

    def test_budget_exactly_three_checks(self):
        variables, constraints = THREE_CHECK_PROBLEM
        result = propagate(variables, constraints, 3)
        self.assertEqual(result["status"], TIMEOUT)
        self.assertEqual(result["used_budget"], 3)
        # Hand-computed truncation: checks are (x=1,y=1) hit, (x=2,y=1)
        # miss, (x=2,y=2) miss -> 2 is pruned from x, then the budget is
        # gone before arc (y, x) can be revised.
        self.assertEqual(result["domains"], {"x": [1], "y": [1, 2]})

    def test_truncation_matches_manual_replay(self):
        variables, constraints = CHAIN_PROBLEM
        _, _, log = run_ac3(variables, constraints)
        total_checks = count_checks(log)
        for budget in range(0, total_checks + 2):
            expected_domains, _ = truncate_at_check(variables, constraints, budget)
            result = propagate(variables, constraints, budget)
            self.assertEqual(
                result["domains"],
                expected_domains,
                "domains diverge at budget %d" % budget,
            )
            self.assertEqual(result["used_budget"], min(budget, total_checks))
            expected_status = COMPLETE if budget >= total_checks else TIMEOUT
            self.assertEqual(result["status"], expected_status)

    def test_budget_never_exceeded(self):
        variables, constraints = CHAIN_PROBLEM
        for budget in range(0, 12):
            result = propagate(variables, constraints, budget)
            self.assertLessEqual(result["used_budget"], budget)


class TestBoundaryConditions(unittest.TestCase):
    """Scenarios 3 and 4: empty initial domains and zero budget."""

    def test_initial_empty_domain_is_unsat_at_any_budget(self):
        variables = {"x": [], "y": [1, 2]}
        constraints = [{"var1": "x", "var2": "y", "allowed": [[1, 1]]}]
        for budget in (0, 1, 100):
            result = propagate(variables, constraints, budget)
            self.assertEqual(result["status"], UNSAT)
            self.assertEqual(result["used_budget"], 0)
            self.assertEqual(result["domains"], {"x": [], "y": [1, 2]})

    def test_zero_budget_without_conflict_is_timeout(self):
        variables, constraints = CHAIN_PROBLEM
        result = propagate(variables, constraints, 0)
        self.assertEqual(result["status"], TIMEOUT)
        self.assertEqual(result["used_budget"], 0)
        self.assertEqual(result["domains"], variables)

    def test_zero_budget_no_constraints_is_complete(self):
        # With no arcs there is nothing to check, so the fixpoint is
        # reached immediately without spending budget.
        result = propagate({"x": [1, 2]}, [], 0)
        self.assertEqual(result["status"], COMPLETE)
        self.assertEqual(result["used_budget"], 0)
        self.assertEqual(result["domains"], {"x": [1, 2]})

    def test_negative_budget_rejected(self):
        with self.assertRaises(InputError):
            propagate({"x": [1]}, [], -1)

    def test_unsat_discards_remaining_budget(self):
        variables = {"x": [1], "y": [2]}
        constraints = [{"var1": "x", "var2": "y", "allowed": [[1, 1]]}]
        result = propagate(variables, constraints, 500)
        self.assertEqual(result["status"], UNSAT)
        self.assertEqual(result["used_budget"], 1)


class TestCli(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "csp_budget", *args],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def write_problem(self, data):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        with handle:
            if isinstance(data, str):
                handle.write(data)
            else:
                json.dump(data, handle)
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_propagate_success(self):
        variables, constraints = CHAIN_PROBLEM
        path = self.write_problem(
            {"variables": variables, "constraints": constraints}
        )
        proc = self.run_cli("propagate", "--input", path, "--budget", "1000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["status"], COMPLETE)
        self.assertIn("domains", output)
        self.assertIn("used_budget", output)
        expected = propagate(variables, constraints, 1000)
        self.assertEqual(output["domains"], expected["domains"])
        self.assertEqual(output["used_budget"], expected["used_budget"])

    def test_negative_budget_fails(self):
        path = self.write_problem({"variables": {"x": [1]}, "constraints": []})
        proc = self.run_cli("propagate", "--input", path, "--budget", "-1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("budget", proc.stderr)

    def test_malformed_json_fails(self):
        path = self.write_problem("{not valid json")
        proc = self.run_cli("propagate", "--input", path, "--budget", "10")
        self.assertNotEqual(proc.returncode, 0)

    def test_unknown_variable_in_constraint_fails(self):
        path = self.write_problem(
            {
                "variables": {"x": [1]},
                "constraints": [{"var1": "x", "var2": "ghost", "allowed": [[1, 1]]}],
            }
        )
        proc = self.run_cli("propagate", "--input", path, "--budget", "10")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown variable", proc.stderr)

    def test_missing_file_fails(self):
        proc = self.run_cli(
            "propagate", "--input", "/nonexistent/problem.json", "--budget", "10"
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_invalid_problem_shape_fails(self):
        path = self.write_problem({"variables": {"x": "not-a-list"}, "constraints": []})
        proc = self.run_cli("propagate", "--input", path, "--budget", "10")
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
