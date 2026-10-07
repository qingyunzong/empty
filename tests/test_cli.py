import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TABLE_A = {
    "segments": [
        {"utc_start": None, "offset": "+01:00"},
        {"utc_start": "2024-03-31T01:00:00Z", "offset": "+02:00"},
        {"utc_start": "2024-10-27T01:00:00Z", "offset": "+01:00"},
    ]
}

TABLE_BAD = {
    "segments": [
        {"utc_start": None, "utc_end": "2024-06-01T00:00:00Z", "offset": "+01:00"},
        {"utc_start": "2024-05-01T00:00:00Z", "offset": "+02:00"},
    ]
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "timeaxis", *args],
        cwd=REPO_ROOT, capture_output=True, text=True)


class CliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.table_path = os.path.join(cls.tmp.name, "table.json")
        with open(cls.table_path, "w", encoding="utf-8") as fh:
            json.dump(TABLE_A, fh)
        cls.bad_path = os.path.join(cls.tmp.name, "bad.json")
        with open(cls.bad_path, "w", encoding="utf-8") as fh:
            json.dump(TABLE_BAD, fh)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_validate_ok(self):
        proc = run_cli("validate", self.table_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), {"valid": True, "segments": 3})

    def test_validate_rejects_overlap(self):
        proc = run_cli("validate", self.bad_path)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("overlap", json.loads(proc.stderr)["error"])

    def test_to_instant_gap_and_fold(self):
        proc = run_cli("to-instant", self.table_path, "2024-03-31T02:30:00")
        self.assertEqual(json.loads(proc.stdout)["count"], 0)
        proc = run_cli("to-instant", self.table_path, "2024-10-27T02:30:00")
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["candidates"][0]["instant"], "2024-10-27T00:30:00Z")
        self.assertEqual(payload["candidates"][1]["segment_index"], 2)

    def test_to_local(self):
        proc = run_cli("to-local", self.table_path, "2024-03-31T00:30:00Z")
        self.assertEqual(json.loads(proc.stdout)["local"], "2024-03-31T01:30:00")

    def test_interval_json(self):
        proc = run_cli("interval", self.table_path,
                       "2024-03-31T01:00:00", "2024-03-31T04:00:00")
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["utc_intervals"][0]["utc_start"],
                         "2024-03-31T00:00:00Z")
        self.assertFalse(payload["utc_intervals"][0]["end_closed"])
        self.assertEqual(payload["utc_intervals"][1]["segment_index"], 1)

    def test_arithmetic_commands(self):
        proc = run_cli("add-days", "2024-03-31T00:00:00", "1")
        self.assertEqual(json.loads(proc.stdout)["result"], "2024-04-01T00:00:00")
        proc = run_cli("add-months", "2024-01-31T10:00:00", "1")
        self.assertEqual(json.loads(proc.stdout)["result"], "2024-02-29T10:00:00")
        proc = run_cli("add-seconds", "2024-03-31T00:00:00Z", "86400")
        self.assertEqual(json.loads(proc.stdout)["result"], "2024-04-01T00:00:00Z")

    def test_evidence_command(self):
        proc = run_cli("evidence", self.table_path)
        rows = json.loads(proc.stdout)["segments"]
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[1]["offset"], "+02:00")
        self.assertEqual(rows[1]["local_start"], "2024-03-31T03:00:00")

    def test_enumerate_command(self):
        proc = run_cli("enumerate", self.table_path,
                       "2024-03-31T00:00:00Z", "2024-03-31T00:00:05Z")
        rows = json.loads(proc.stdout)["rows"]
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0]["local"], "2024-03-31T01:00:00")
        self.assertEqual(rows[0]["segment_index"], 0)


if __name__ == "__main__":
    unittest.main()
