"""Error handling: exit code 2 and single-line {"error": ...} on stderr."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(src):
    return subprocess.run(
        [sys.executable, "-m", "rostersolve", "plan", src],
        capture_output=True, text=True, cwd=REPO_ROOT)


class TestErrors(unittest.TestCase):
    def check_error(self, content, needle):
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.json")
            mode = "w"
            with open(src, mode, encoding="utf-8") as fh:
                fh.write(content if isinstance(content, str)
                         else json.dumps(content))
            proc = run_cli(src)
            self.assertEqual(proc.returncode, 2, proc.stderr)
            lines = proc.stderr.strip().splitlines()
            self.assertEqual(len(lines), 1)
            payload = json.loads(lines[0])
            self.assertIn("error", payload)
            self.assertIn(needle, payload["error"])

    def test_invalid_json(self):
        self.check_error("{not json", "invalid JSON")

    def test_missing_field(self):
        self.check_error(
            {"jobs": [{"id": "j1", "cpu": 1, "mem": 1, "duration": 1}],
             "machines": [], "horizon": 4},
            "missing field 'deadline'")

    def test_missing_top_level(self):
        self.check_error({"jobs": [], "machines": []}, "missing field 'horizon'")

    def test_cyclic_dependency(self):
        self.check_error(
            {"horizon": 4,
             "jobs": [
                 {"id": "a", "cpu": 1, "mem": 1, "deadline": 4,
                  "duration": 1, "deps": ["b"]},
                 {"id": "b", "cpu": 1, "mem": 1, "deadline": 4,
                  "duration": 1, "deps": ["a"]},
             ],
             "machines": [{"id": "m", "cpu": 1, "mem": 1}]},
            "cyclic dependency")

    def test_negative_resource(self):
        self.check_error(
            {"horizon": 4,
             "jobs": [{"id": "a", "cpu": -1, "mem": 1, "deadline": 4,
                       "duration": 1}],
             "machines": [{"id": "m", "cpu": 1, "mem": 1}]},
            "negative resource")

    def test_unknown_dependency(self):
        self.check_error(
            {"horizon": 4,
             "jobs": [{"id": "a", "cpu": 1, "mem": 1, "deadline": 4,
                       "duration": 1, "deps": ["ghost"]}],
             "machines": [{"id": "m", "cpu": 1, "mem": 1}]},
            "unknown dependency")


if __name__ == "__main__":
    unittest.main()
