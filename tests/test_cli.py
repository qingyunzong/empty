"""CLI tests: python -m csp_arith explain --input <file>."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "csp_arith", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


def write_problem(problem):
    handle = tempfile.NamedTemporaryFile(
        mode="w", suffix=".json", delete=False, encoding="utf-8"
    )
    with handle:
        json.dump(problem, handle)
    return handle.name


class CliExplainTest(unittest.TestCase):
    def test_valid_problem_outputs_json(self):
        path = write_problem(
            {
                "variables": {"x": [1, 2, 3], "y": [2, 3]},
                "constraints": [{"type": "lt", "vars": ["x", "y"]}],
            }
        )
        proc = run_cli("explain", "--input", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "sat")
        self.assertEqual(result["domains"], {"x": [1, 2], "y": [2, 3]})
        self.assertEqual(
            result["explanations"],
            {
                "x": [
                    {
                        "var": "x",
                        "value": 3,
                        "constraint": "lt",
                        "constraint_id": 0,
                        "other_var": "y",
                        "premise": {"var": "y", "max": 3},
                    }
                ]
            },
        )
        self.assertIsNone(result["conflict"])

    def test_unsat_problem_reports_conflict(self):
        path = write_problem(
            {
                "variables": {"x": [1, 2, 3], "y": [5]},
                "constraints": [{"type": "lt", "vars": ["y", "x"]}],
            }
        )
        proc = run_cli("explain", "--input", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "unsat")
        self.assertIsNotNone(result["conflict"])
        self.assertEqual(result["domains"][result["conflict"]["var"]], [])

    def test_unknown_constraint_type_is_error(self):
        path = write_problem(
            {
                "variables": {"x": [1], "y": [2]},
                "constraints": [{"type": "gt", "vars": ["x", "y"]}],
            }
        )
        proc = run_cli("explain", "--input", path)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown constraint type", proc.stderr)

    def test_unknown_variable_is_error(self):
        path = write_problem(
            {
                "variables": {"x": [1]},
                "constraints": [{"type": "eq", "vars": ["x", "z"]}],
            }
        )
        proc = run_cli("explain", "--input", path)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown variable", proc.stderr)

    def test_non_integer_domain_values_are_error(self):
        for bad_value in (1.5, "2", True, None):
            with self.subTest(bad_value=bad_value):
                path = write_problem(
                    {
                        "variables": {"x": [1, bad_value], "y": [2]},
                        "constraints": [{"type": "le", "vars": ["x", "y"]}],
                    }
                )
                proc = run_cli("explain", "--input", path)
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn("non-integer", proc.stderr)

    def test_missing_input_file_is_error(self):
        proc = run_cli("explain", "--input", "/nonexistent/problem.json")
        self.assertNotEqual(proc.returncode, 0)

    def test_invalid_json_is_error(self):
        handle = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        )
        with handle:
            handle.write("{not json")
        proc = run_cli("explain", "--input", handle.name)
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
