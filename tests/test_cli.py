"""CLI tests: python -m csp_arith explain --input <file>.

Covers the error conventions (acceptance scenario 3) and end-to-end
JSON output.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(problem):
    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    ) as handle:
        json.dump(problem, handle)
        path = handle.name
    try:
        return subprocess.run(
            [sys.executable, "-m", "csp_arith", "explain", "--input", path],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
    finally:
        os.unlink(path)


class CliSuccessTest(unittest.TestCase):
    def test_scenario1_end_to_end(self):
        problem = {
            "variables": {"x": [1, 2, 3], "y": [2, 3]},
            "constraints": [{"type": "lt", "vars": ["x", "y"]}],
        }
        proc = run_cli(problem)
        self.assertEqual(0, proc.returncode, msg=proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual("consistent", output["status"])
        self.assertEqual({"x": [1, 2], "y": [2, 3]}, output["domains"])
        self.assertEqual(
            [
                {
                    "variable": "x",
                    "value": 3,
                    "constraint": "lt",
                    "vars": ["x", "y"],
                    "premise": {"max": 3},
                }
            ],
            output["explanations"],
        )

    def test_inconsistent_output_has_conflict(self):
        problem = {
            "variables": {"x": [1], "y": [1]},
            "constraints": [{"type": "ne", "vars": ["x", "y"]}],
        }
        proc = run_cli(problem)
        self.assertEqual(0, proc.returncode, msg=proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual("inconsistent", output["status"])
        self.assertIn("conflict", output)
        self.assertEqual("x", output["conflict"]["variable"])
        self.assertEqual([], output["domains"]["x"])


class CliErrorConventionTest(unittest.TestCase):
    """Invalid input must exit with a non-zero status code."""

    def assert_cli_error(self, problem, needle):
        proc = run_cli(problem)
        self.assertNotEqual(0, proc.returncode, msg="expected a non-zero exit code")
        self.assertIn(needle, proc.stderr)

    def test_unknown_constraint_type(self):
        self.assert_cli_error(
            {
                "variables": {"x": [1], "y": [2]},
                "constraints": [{"type": "gt", "vars": ["x", "y"]}],
            },
            "unknown constraint type",
        )

    def test_unknown_variable_reference(self):
        self.assert_cli_error(
            {
                "variables": {"x": [1]},
                "constraints": [{"type": "lt", "vars": ["x", "z"]}],
            },
            "unknown variable",
        )

    def test_non_integer_domain_value(self):
        self.assert_cli_error(
            {
                "variables": {"x": [1, "two"], "y": [2]},
                "constraints": [],
            },
            "non-integer",
        )

    def test_boolean_domain_value_is_not_an_integer(self):
        self.assert_cli_error(
            {
                "variables": {"x": [1, True], "y": [2]},
                "constraints": [],
            },
            "non-integer",
        )

    def test_float_domain_value(self):
        self.assert_cli_error(
            {
                "variables": {"x": [1.5], "y": [2]},
                "constraints": [],
            },
            "non-integer",
        )

    def test_missing_input_file(self):
        proc = subprocess.run(
            [sys.executable, "-m", "csp_arith", "explain", "--input",
             "/nonexistent/problem.json"],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )
        self.assertNotEqual(0, proc.returncode)
        self.assertIn("not found", proc.stderr)


if __name__ == "__main__":
    unittest.main()
