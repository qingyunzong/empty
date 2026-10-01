import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CHAIN_PROBLEM = {
    "variables": {"a": [1, 2, 3, 4], "b": [1, 2, 3, 4], "c": [1, 2, 3, 4]},
    "constraints": [
        {"vars": ["a", "b"], "allowed": [[i, j] for i in range(1, 5) for j in range(1, 5) if i < j]},
        {"vars": ["b", "c"], "allowed": [[i, j] for i in range(1, 5) for j in range(1, 5) if i < j]},
    ],
}

UNSAT_PROBLEM = {
    "variables": {"a": [1, 2], "b": [1]},
    "constraints": [{"vars": ["a", "b"], "allowed": []}],
}


def run_cli(*argv):
    return subprocess.run(
        [sys.executable, "-m", "csp_trail", *argv],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.problem_path = Path(self.tmp.name) / "problem.json"
        self.problem_path.write_text(json.dumps(CHAIN_PROBLEM), encoding="utf-8")
        self.unsat_path = Path(self.tmp.name) / "unsat.json"
        self.unsat_path.write_text(json.dumps(UNSAT_PROBLEM), encoding="utf-8")

    def test_run_without_assignments(self):
        result = run_cli("run", "--input", str(self.problem_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["current_level"], 0)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"], {"a": [1, 2], "b": [2, 3], "c": [3, 4]})

    def test_run_with_assignments(self):
        result = run_cli(
            "run", "--input", str(self.problem_path), "--assign", '{"a": 1, "b": 3}'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["current_level"], 2)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"], {"a": [1], "b": [3], "c": [4]})

    def test_run_conflict_undoes_assignment(self):
        result = run_cli(
            "run",
            "--input", str(self.problem_path),
            "--assign", '{"a": 1, "b": 3, "c": 3}',
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["status"], "conflict")
        self.assertEqual(out["current_level"], 2)
        self.assertEqual(out["domains"], {"a": [1], "b": [3], "c": [4]})

    def test_run_with_backtrack(self):
        result = run_cli(
            "run",
            "--input", str(self.problem_path),
            "--assign", '{"a": 1, "b": 3}',
            "--backtrack", "1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["current_level"], 1)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"], {"a": [1], "b": [2, 3], "c": [3, 4]})

    def test_run_unsat(self):
        result = run_cli("run", "--input", str(self.unsat_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        self.assertEqual(out["status"], "unsat")
        self.assertEqual(out["current_level"], 0)

    def test_unknown_variable_exits_nonzero(self):
        result = run_cli(
            "run", "--input", str(self.problem_path), "--assign", '{"zz": 1}'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)
        self.assertIn("zz", result.stderr)

    def test_value_outside_domain_exits_nonzero(self):
        result = run_cli(
            "run", "--input", str(self.problem_path), "--assign", '{"a": 99}'
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)
        self.assertIn("99", result.stderr)

    def test_backtrack_negative_level_exits_nonzero(self):
        result = run_cli(
            "run", "--input", str(self.problem_path), "--backtrack", "-1"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)

    def test_backtrack_above_current_level_exits_nonzero(self):
        result = run_cli(
            "run",
            "--input", str(self.problem_path),
            "--assign", '{"a": 1}',
            "--backtrack", "5",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)

    def test_missing_input_file_exits_nonzero(self):
        result = run_cli("run", "--input", str(self.tmp_path() / "missing.json"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)

    def tmp_path(self):
        return Path(self.tmp.name)


if __name__ == "__main__":
    unittest.main()
