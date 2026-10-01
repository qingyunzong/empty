"""CLI tests: python -m csp_restart run ..."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = ROOT / "examples"


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "csp_restart", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class CliRunTest(unittest.TestCase):
    def test_sat_with_restart(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "three_var.json"),
            "--restart-threshold", "2", "--total-budget", "1000",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "sat")
        self.assertEqual(out["solution"], {"x": 2, "y": 1, "z": 4})
        self.assertEqual(out["restart_count"], 1)
        self.assertIn({"x": 1, "y": 1}, out["nogoods"])
        self.assertIn({"x": 1, "y": 2}, out["nogoods"])
        for field in ("status", "solution", "nogoods", "restart_count"):
            self.assertIn(field, out)

    def test_threshold_one_single_restart(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "two_var_restart.json"),
            "--restart-threshold", "1", "--total-budget", "1000",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "sat")
        self.assertEqual(out["solution"], {"x": 2, "y": 1})
        self.assertEqual(out["restart_count"], 1)
        self.assertEqual(out["nogoods"], [{"x": 1}])

    def test_zero_budget_is_timeout(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "two_var_restart.json"),
            "--restart-threshold", "1", "--total-budget", "0",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "timeout")
        self.assertIsNone(out["solution"])
        self.assertEqual(out["restart_count"], 0)

    def test_initial_contradiction_is_unsat_without_restart(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "root_unsat.json"),
            "--restart-threshold", "1", "--total-budget", "1000",
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unsat")
        self.assertIsNone(out["solution"])
        self.assertEqual(out["restart_count"], 0)
        self.assertEqual(out["nogoods"], [])


class CliErrorTest(unittest.TestCase):
    def test_negative_restart_threshold(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "two_var_restart.json"),
            "--restart-threshold", "-1", "--total-budget", "10",
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_negative_total_budget(self):
        proc = run_cli(
            "run", "--input", str(EXAMPLES / "two_var_restart.json"),
            "--restart-threshold", "1", "--total-budget", "-5",
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_missing_input_file(self):
        proc = run_cli(
            "run", "--input", str(ROOT / "does_not_exist.json"),
            "--restart-threshold", "1", "--total-budget", "10",
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_malformed_json(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            fh.write("{not valid json")
            path = fh.name
        proc = run_cli(
            "run", "--input", path,
            "--restart-threshold", "1", "--total-budget", "10",
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_invalid_problem_definition(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as fh:
            json.dump(
                {"variables": [{"name": "x", "domain": [1]}],
                 "constraints": [{"type": "bogus", "vars": ["x"]}]},
                fh,
            )
            path = fh.name
        proc = run_cli(
            "run", "--input", path,
            "--restart-threshold", "1", "--total-budget", "10",
        )
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
