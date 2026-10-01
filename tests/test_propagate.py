import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from csp_budget.solver import CSPError, propagate, reference_ac3


# X=[1,2,3], Y=[1,2,3], Z=[1,2,3]
# c0(X,Y) allowed {(1,2),(2,3)}  -> X loses 3, Y loses 1
# c1(Y,Z) allowed {(2,1),(3,2)}  -> Z loses 3
SAMPLE_PROBLEM = {
    "variables": {"X": [1, 2, 3], "Y": [1, 2, 3], "Z": [1, 2, 3]},
    "constraints": [
        {"scope": ["X", "Y"], "allowed": [[1, 2], [2, 3]]},
        {"scope": ["Y", "Z"], "allowed": [[2, 1], [3, 2]]},
    ],
}

UNSAT_PROBLEM = {
    "variables": {"X": [1], "Y": [2]},
    "constraints": [{"scope": ["X", "Y"], "allowed": [[1, 1]]}],
}

EMPTY_DOMAIN_PROBLEM = {
    "variables": {"X": [], "Y": [1, 2]},
    "constraints": [{"scope": ["X", "Y"], "allowed": [[1, 1]]}],
}


class TestReferenceMatchesBudgeted(unittest.TestCase):
    """Acceptance 1: large budget == naive AC-3 with execution log."""

    def test_complete_matches_reference(self):
        reference = reference_ac3(SAMPLE_PROBLEM)
        checks_in_log = [entry for entry in reference["log"] if entry[0] == "check"]
        self.assertEqual(reference["status"], "complete")
        self.assertEqual(reference["used_budget"], len(checks_in_log))
        self.assertGreater(reference["used_budget"], 0)

        result = propagate(SAMPLE_PROBLEM, budget=10_000)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["domains"], reference["domains"])
        self.assertEqual(result["used_budget"], reference["used_budget"])
        self.assertEqual(
            result["remaining_budget"], 10_000 - reference["used_budget"]
        )

    def test_expected_fixpoint_domains(self):
        result = propagate(SAMPLE_PROBLEM, budget=10_000)
        self.assertEqual(
            result["domains"], {"X": [1, 2], "Y": [2, 3], "Z": [1, 2]}
        )


class TestBudgetTruncation(unittest.TestCase):
    """Acceptance 2: budget == first N match checks stops exactly there."""

    def test_budget_of_three_checks(self):
        truncated = reference_ac3(SAMPLE_PROBLEM, max_checks=3)
        self.assertEqual(truncated["status"], "timeout")
        self.assertEqual(truncated["used_budget"], 3)
        # Only 3 checks executed: (X=1,Y=1) no, (X=1,Y=2) yes, (X=2,Y=1) no.
        self.assertEqual(
            truncated["log"],
            [
                ("check", "X", 1, "Y", 1),
                ("check", "X", 1, "Y", 2),
                ("check", "X", 2, "Y", 1),
            ],
        )
        # No removal happened yet, so domains are the initial ones.
        self.assertEqual(truncated["domains"], SAMPLE_PROBLEM["variables"])

        result = propagate(SAMPLE_PROBLEM, budget=3)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["used_budget"], 3)
        self.assertEqual(result["remaining_budget"], 0)
        self.assertEqual(result["domains"], truncated["domains"])

    def test_truncation_after_first_removal(self):
        # First removal (X=3) happens after 8 checks; budget 9 stops inside
        # the next arc revision, keeping X=[1,2].
        truncated = reference_ac3(SAMPLE_PROBLEM, max_checks=9)
        result = propagate(SAMPLE_PROBLEM, budget=9)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["domains"], truncated["domains"])
        self.assertEqual(result["domains"]["X"], [1, 2])
        self.assertEqual(result["used_budget"], 9)

    def test_every_budget_prefix_matches_reference(self):
        reference = reference_ac3(SAMPLE_PROBLEM)
        total = reference["used_budget"]
        for budget in range(0, total + 2):
            truncated = reference_ac3(SAMPLE_PROBLEM, max_checks=budget)
            result = propagate(SAMPLE_PROBLEM, budget=budget)
            self.assertEqual(result["status"], truncated["status"], budget)
            self.assertEqual(result["domains"], truncated["domains"], budget)
            self.assertEqual(result["used_budget"], truncated["used_budget"], budget)


class TestBoundarySemantics(unittest.TestCase):
    """Acceptance 3 & 4 plus unsat-during-propagation."""

    def test_empty_initial_domain_always_unsat(self):
        for budget in (0, 1, 10_000):
            result = propagate(EMPTY_DOMAIN_PROBLEM, budget=budget)
            self.assertEqual(result["status"], "unsat")
            self.assertEqual(result["used_budget"], 0)
            self.assertEqual(result["domains"], EMPTY_DOMAIN_PROBLEM["variables"])

    def test_zero_budget_returns_initial_domains_timeout(self):
        result = propagate(SAMPLE_PROBLEM, budget=0)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["used_budget"], 0)
        self.assertEqual(result["remaining_budget"], 0)
        self.assertEqual(result["domains"], SAMPLE_PROBLEM["variables"])

    def test_unsat_during_propagation_discards_budget(self):
        result = propagate(UNSAT_PROBLEM, budget=10_000)
        self.assertEqual(result["status"], "unsat")
        self.assertEqual(result["used_budget"], 1)
        self.assertEqual(result["domains"]["X"], [])
        # Reference agrees.
        reference = reference_ac3(UNSAT_PROBLEM)
        self.assertEqual(reference["status"], "unsat")
        self.assertEqual(reference["domains"], result["domains"])
        self.assertEqual(reference["used_budget"], result["used_budget"])

    def test_timeout_never_reported_as_unsat_or_complete(self):
        # Budget runs out exactly when the next check would reveal the wipeout.
        result = propagate(UNSAT_PROBLEM, budget=0)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["domains"], UNSAT_PROBLEM["variables"])


class TestValidationErrors(unittest.TestCase):
    def test_negative_budget(self):
        with self.assertRaises(CSPError):
            propagate(SAMPLE_PROBLEM, budget=-1)

    def test_non_integer_budget(self):
        with self.assertRaises(CSPError):
            propagate(SAMPLE_PROBLEM, budget=1.5)
        with self.assertRaises(CSPError):
            propagate(SAMPLE_PROBLEM, budget=True)

    def test_unknown_variable_in_constraint(self):
        problem = {
            "variables": {"X": [1]},
            "constraints": [{"scope": ["X", "Y"], "allowed": [[1, 1]]}],
        }
        with self.assertRaises(CSPError):
            propagate(problem, budget=10)

    def test_malformed_inputs(self):
        bad_inputs = [
            None,
            [],
            {"variables": {}},
            {"variables": {"X": "notalist"}},
            {"variables": {"X": [1, "a"]}},
            {"variables": {"X": [1]}, "constraints": "nope"},
            {"variables": {"X": [1]}, "constraints": [{"scope": ["X"]}]},
            {
                "variables": {"X": [1]},
                "constraints": [{"scope": ["X", "X"], "allowed": [[1]]}],
            },
        ]
        for problem in bad_inputs:
            with self.assertRaises(CSPError, msg=repr(problem)):
                propagate(problem, budget=10)


class TestCLI(unittest.TestCase):
    def run_cli(self, argv, cwd=REPO_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "csp_budget", *argv],
            capture_output=True,
            text=True,
            cwd=cwd,
        )

    def write_problem(self, problem):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(problem, fh)
        self.addCleanup(os.unlink, path)
        return path

    def test_cli_complete(self):
        path = self.write_problem(SAMPLE_PROBLEM)
        proc = self.run_cli(["propagate", "--input", path, "--budget", "10000"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["status"], "complete")
        self.assertEqual(output["domains"], {"X": [1, 2], "Y": [2, 3], "Z": [1, 2]})
        self.assertEqual(output["used_budget"], 24)
        self.assertEqual(set(output), {"status", "domains", "used_budget"})

    def test_cli_timeout_zero_budget(self):
        path = self.write_problem(SAMPLE_PROBLEM)
        proc = self.run_cli(["propagate", "--input", path, "--budget", "0"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["status"], "timeout")
        self.assertEqual(output["used_budget"], 0)
        self.assertEqual(output["domains"], SAMPLE_PROBLEM["variables"])

    def test_cli_negative_budget_fails(self):
        path = self.write_problem(SAMPLE_PROBLEM)
        proc = self.run_cli(["propagate", "--input", path, "--budget", "-5"])
        self.assertNotEqual(proc.returncode, 0)

    def test_cli_invalid_json_fails(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        self.addCleanup(os.unlink, path)
        proc = self.run_cli(["propagate", "--input", path, "--budget", "10"])
        self.assertNotEqual(proc.returncode, 0)

    def test_cli_unknown_variable_fails(self):
        problem = {
            "variables": {"X": [1]},
            "constraints": [{"scope": ["X", "ZZ"], "allowed": [[1, 1]]}],
        }
        path = self.write_problem(problem)
        proc = self.run_cli(["propagate", "--input", path, "--budget", "10"])
        self.assertNotEqual(proc.returncode, 0)

    def test_cli_missing_file_fails(self):
        proc = self.run_cli(
            ["propagate", "--input", "/nonexistent/nope.json", "--budget", "10"]
        )
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
