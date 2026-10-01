import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HISTORY_OK = {
    "operations": [
        {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 10},
        {"id": "p2", "op": "push", "arg": 2, "call": 1, "return": 9},
        {"id": "p3", "op": "pop", "call": 2, "return": 8, "result": 2},
    ]
}

HISTORY_INFEASIBLE = {
    "operations": [
        {"id": "p1", "op": "push", "arg": 1, "call": 0, "return": 1},
        {"id": "p2", "op": "push", "arg": 2, "call": 2, "return": 3},
        {"id": "p3", "op": "pop", "call": 4, "return": 8, "result": 1},
    ]
}

HISTORY_UNKNOWN = {
    "operations": [
        {"id": "p1", "op": "push", "arg": 5, "call": 0},
        {"id": "p2", "op": "pop", "call": 1, "return": 4, "result": 5},
    ]
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "lpsynth", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class CliTestCase(unittest.TestCase):
    def write_history(self, payload):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            if isinstance(payload, str):
                fh.write(payload)
            else:
                json.dump(payload, fh)
        self.addCleanup(os.unlink, path)
        return path


class TestCliSolve(CliTestCase):
    def test_ok_history_exit_0(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "2000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "OK")
        self.assertEqual(
            out["intervals"],
            {"p1": [0, 10], "p2": [1, 2], "p3": [2, 8]},
        )
        self.assertIsNone(out["conflict"])

    def test_infeasible_history_exit_0(self):
        path = self.write_history(HISTORY_INFEASIBLE)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "2000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "INFEASIBLE")
        self.assertEqual(out["conflict"], ["p3"])

    def test_unknown_history_exit_0(self):
        path = self.write_history(HISTORY_UNKNOWN)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "2000")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "UNKNOWN")
        self.assertIsNone(out["conflict"])

    def test_zero_timeout_exit_6(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--type", "stack", "--timeout-ms", "0")
        self.assertEqual(proc.returncode, 6, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "TIMEOUT")
        self.assertEqual(
            out["intervals"],
            {"p1": [0, 10], "p2": [1, 9], "p3": [2, 8]},
        )


class TestCliInvalidInput(CliTestCase):
    def test_malformed_json_exit_2(self):
        path = self.write_history("{not valid json")
        proc = run_cli("solve", path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr.lower())

    def test_missing_file_exit_2(self):
        proc = run_cli("solve", "/nonexistent/history.json")
        self.assertEqual(proc.returncode, 2)

    def test_invalid_operation_exit_2(self):
        path = self.write_history({"operations": [{"id": "x", "op": "peek"}]})
        proc = run_cli("solve", path)
        self.assertEqual(proc.returncode, 2)

    def test_bad_type_flag_exit_2(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--type", "queue")
        self.assertEqual(proc.returncode, 2)

    def test_negative_timeout_exit_2(self):
        path = self.write_history(HISTORY_OK)
        proc = run_cli("solve", path, "--timeout-ms", "-5")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
