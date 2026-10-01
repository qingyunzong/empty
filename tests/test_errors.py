import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli_raw(input_path):
    return subprocess.run(
        [sys.executable, "-m", "rostersolve", "plan", input_path],
        cwd=ROOT, capture_output=True, text=True)


class TestInputErrors(unittest.TestCase):
    """Invalid JSON / missing fields / cyclic deps / negative resources
    must exit with code 2 and a single-line {"error": ...} on stderr."""

    def check_error(self, doc_text):
        with tempfile.TemporaryDirectory() as tmp:
            in_path = os.path.join(tmp, "in.json")
            with open(in_path, "w") as fh:
                fh.write(doc_text)
            result = run_cli_raw(in_path)
        self.assertEqual(result.returncode, 2,
                         "expected exit 2, got %d (%s)" % (result.returncode, result.stderr))
        lines = result.stderr.strip().splitlines()
        self.assertEqual(len(lines), 1, "stderr must be a single line")
        payload = json.loads(lines[0])
        self.assertIn("error", payload)
        self.assertIsInstance(payload["error"], str)
        return payload["error"]

    def test_invalid_json(self):
        self.check_error('{"jobs": [not json')

    def test_missing_top_level_field(self):
        self.check_error('{"jobs": [], "machines": []}')

    def test_missing_job_field(self):
        self.check_error(json.dumps({
            "horizon": 4,
            "jobs": [{"id": "a", "cpu": 1, "mem": 1, "duration": 1,
                      "deps": [], "tags": []}],
            "machines": [{"id": "m", "cpu": 1, "mem": 1, "tags": []}],
        }))

    def test_cyclic_dependency(self):
        self.check_error(json.dumps({
            "horizon": 4,
            "jobs": [
                {"id": "a", "cpu": 1, "mem": 1, "duration": 1, "deadline": 4,
                 "deps": ["b"], "tags": []},
                {"id": "b", "cpu": 1, "mem": 1, "duration": 1, "deadline": 4,
                 "deps": ["a"], "tags": []},
            ],
            "machines": [{"id": "m", "cpu": 1, "mem": 1, "tags": []}],
        }))

    def test_negative_resources(self):
        self.check_error(json.dumps({
            "horizon": 4,
            "jobs": [{"id": "a", "cpu": -1, "mem": 1, "duration": 1,
                      "deadline": 4, "deps": [], "tags": []}],
            "machines": [{"id": "m", "cpu": 1, "mem": 1, "tags": []}],
        }))

    def test_unknown_dependency(self):
        self.check_error(json.dumps({
            "horizon": 4,
            "jobs": [{"id": "a", "cpu": 1, "mem": 1, "duration": 1,
                      "deadline": 4, "deps": ["ghost"], "tags": []}],
            "machines": [{"id": "m", "cpu": 1, "mem": 1, "tags": []}],
        }))


if __name__ == "__main__":
    unittest.main()
