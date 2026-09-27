import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run_cli(payload):
    with tempfile.TemporaryDirectory() as directory:
        operations_path = Path(directory) / "ops.json"
        operations_path.write_text(json.dumps(payload), encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, "-m", "dreach", "run", str(operations_path)],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
    return completed


class CliTest(unittest.TestCase):
    def test_run_operations_and_savepoint_rollback(self):
        completed = run_cli([
            {"op": "init", "n": 4},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "savepoint"},
            {"op": "insert", "u": 1, "v": 2},
            {"op": "reachable", "u": 0, "v": 2},
            {"op": "witness", "u": 0, "v": 2},
            {"op": "rollback", "savepoint": 1},
            {"op": "reachable", "u": 0, "v": 2},
            {"op": "witness", "u": 0, "v": 2},
        ])

        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout), {
            "results": [
                {"op": "init", "result": None},
                {"op": "insert", "result": None},
                {"op": "savepoint", "result": 1},
                {"op": "insert", "result": None},
                {"op": "reachable", "result": True},
                {"op": "witness", "result": [0, 1, 2]},
                {"op": "rollback", "result": None},
                {"op": "reachable", "result": False},
                {"op": "witness", "result": None},
            ]
        })

    def test_unknown_savepoint_exits_1_without_partial_output(self):
        completed = run_cli([
            {"op": "init", "n": 2},
            {"op": "insert", "u": 0, "v": 1},
            {"op": "rollback", "savepoint": 42},
        ])

        self.assertEqual(completed.returncode, 1)
        self.assertEqual(completed.stdout, "")
        self.assertIn("unknown savepoint", completed.stderr)

    def test_malformed_json_exits_2(self):
        with tempfile.TemporaryDirectory() as directory:
            operations_path = Path(directory) / "ops.json"
            operations_path.write_text('{"op": "init",}', encoding="utf-8")
            completed = subprocess.run(
                [sys.executable, "-m", "dreach", "run", str(operations_path)],
                cwd=ROOT,
                text=True,
                capture_output=True,
            )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")
        self.assertIn("invalid JSON", completed.stderr)

    def test_schema_error_exits_2(self):
        completed = run_cli([{"op": "init", "n": 3, "extra": True}])

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, "")


if __name__ == "__main__":
    unittest.main()
