import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

HISTORY_OK = {
    "type": "stack",
    "operations": [
        {"id": "p1", "op": "push", "value": 1, "start": 0, "end": 2},
        {"id": "p2", "op": "push", "value": 2, "start": 1, "end": 10},
        {"id": "po", "op": "pop", "value": 2, "start": 5, "end": 8},
    ],
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "lpsynth", *args],
        cwd=ROOT, capture_output=True, text=True,
    )


class CliCase(unittest.TestCase):
    def write_history(self, data):
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(data, tmp)
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        return tmp.name


class TestCliSolve(CliCase):
    def test_ok_exit_0_and_intervals(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "2000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "OK")
        self.assertEqual(out["intervals"], {"p1": [0, 2], "p2": [1, 8], "po": [5, 8]})
        self.assertEqual(out["conflict"], [])

    def test_timeout_exit_6(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "0")
        self.assertEqual(proc.returncode, 6, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "TIMEOUT")
        self.assertEqual(out["intervals"], {"p1": [0, 2], "p2": [1, 10], "po": [5, 8]})

    def test_infeasible_exit_1(self):
        path = self.write_history({
            "type": "stack",
            "operations": [
                {"id": "pa", "op": "push", "value": "A", "start": 0, "end": 2},
                {"id": "pb", "op": "push", "value": "B", "start": 3, "end": 4},
                {"id": "po", "op": "pop", "value": "A", "start": 5, "end": 7},
            ],
        })
        proc = run_cli("solve", path, "--timeout-ms", "2000")
        self.assertEqual(proc.returncode, 1, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "INFEASIBLE")
        self.assertIn("po", out["conflict"])


class TestCliInvalidInput(CliCase):
    def test_missing_file_exit_2(self):
        proc = run_cli("solve", "/nonexistent/history.json")
        self.assertEqual(proc.returncode, 2)

    def test_malformed_json_exit_2(self):
        tmp = tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8")
        tmp.write("{not json")
        tmp.close()
        self.addCleanup(Path(tmp.name).unlink)
        proc = run_cli("solve", tmp.name)
        self.assertEqual(proc.returncode, 2)

    def test_invalid_schema_exit_2(self):
        path = self.write_history({"type": "stack", "operations": [
            {"id": "x", "op": "pop", "start": 0, "end": 1},  # missing return value
        ]})
        proc = run_cli("solve", path)
        self.assertEqual(proc.returncode, 2)

    def test_unsupported_type_exit_2(self):
        proc = run_cli("solve", "whatever.json", "--type", "queue")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
