import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RULE = {
    "anchor": "2021-01-31",
    "time_of_day": "09:00",
    "interval_months": 1,
    "day_spec": "day_of_month",
    "adjust": "following",
    "tz": "UTC",
    "version": 1,
}


def run_cli(*argv):
    return subprocess.run(
        [sys.executable, "-m", "billcal", *argv],
        capture_output=True, text=True)


class TestCLI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.rule_path = Path(cls.tmp.name) / "rule.json"
        cls.rule_path.write_text(json.dumps(RULE))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def expand(self, *extra):
        return run_cli("expand", "--rule", str(self.rule_path),
                       "--start", "2021-01-01T00:00:00Z",
                       "--end", "2022-01-01T00:00:00Z", *extra)

    def test_tables(self):
        proc = run_cli("tables")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("America/New_York", json.loads(proc.stdout)["tables"])

    def test_expand_full(self):
        proc = self.expand()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(len(data["occurrences"]), 12)
        self.assertEqual(data["occurrences"][0]["utc"], "2021-02-01T09:00:00Z")
        # 2021-01-31 is a Sunday -> following -> Monday 2021-02-01.
        self.assertTrue(any("adjust" in s
                            for s in data["occurrences"][0]["steps"]))

    def test_expand_paginated_and_stale_cursor(self):
        proc = self.expand("--limit", "5")
        data = json.loads(proc.stdout)
        self.assertEqual(len(data["occurrences"]), 5)
        cursor = data["next_cursor"]
        self.assertIsNotNone(cursor)

        proc2 = self.expand("--limit", "5", "--cursor", cursor)
        data2 = json.loads(proc2.stdout)
        self.assertEqual(data2["occurrences"][0]["utc"],
                         json.loads(self.expand().stdout)["occurrences"][5]["utc"])

        # Rule modified -> version bumped: old cursor must be rejected.
        changed = dict(RULE, version=2)
        self.rule_path.write_text(json.dumps(changed))
        try:
            proc3 = self.expand("--limit", "5", "--cursor", cursor)
            self.assertEqual(proc3.returncode, 2)
            self.assertIn("error", json.loads(proc3.stderr))
        finally:
            self.rule_path.write_text(json.dumps(RULE))

    def test_expand_backward(self):
        proc = self.expand("--limit", "3", "--direction", "backward")
        data = json.loads(proc.stdout)
        self.assertEqual(data["occurrences"][-1]["utc"], "2021-12-31T09:00:00Z")
        self.assertIsNotNone(data["prev_cursor"])

    def test_verify(self):
        proc = run_cli("verify", "--rule", str(self.rule_path),
                       "--start-year", "2019", "--end-year", "2031")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["match"])

    def test_bad_rule_file(self):
        proc = run_cli("expand", "--rule", "/nonexistent.json",
                       "--start", "2021-01-01T00:00:00Z",
                       "--end", "2022-01-01T00:00:00Z")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", json.loads(proc.stderr))


if __name__ == "__main__":
    unittest.main()
