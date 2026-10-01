import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

RULE = {
    "name": "monthly-billing",
    "anchor": "2024-01-31",
    "interval_months": 1,
    "day_of_month": 31,
    "anchor_mode": "original",
    "adjust": "following",
    "time_of_day": "09:30",
    "zone": "America/New_York",
    "gap_policy": "shift_forward",
    "repeat_policy": "earlier",
    "add_dates": [],
    "remove_dates": [],
    "version": 1,
}

HOLIDAYS = {
    "holidays": {"2024-12-31": "New Year's Eve", "2025-01-01": "New Year"},
    "weekend": [5, 6],
}


def run_cli(*args, stdin=None):
    env = dict(os.environ, PYTHONPATH=str(REPO))
    return subprocess.run(
        [sys.executable, "-m", "billcycle", *args],
        capture_output=True, text=True, cwd=REPO, env=env, input=stdin)


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rule_path = Path(self.tmp.name) / "rule.json"
        self.cal_path = Path(self.tmp.name) / "holidays.json"
        self.rule_path.write_text(json.dumps(RULE))
        self.cal_path.write_text(json.dumps(HOLIDAYS))

    def tearDown(self):
        self.tmp.cleanup()

    def expand(self, *extra, rule_path=None):
        return run_cli("expand", "--rule", str(rule_path or self.rule_path),
                       "--holidays", str(self.cal_path),
                       "--start", "2024-01-01T00:00:00Z",
                       "--end", "2026-01-01T00:00:00Z", *extra)


class TestCliExpand(CliCase):
    def test_expand_outputs_json_with_steps(self):
        proc = self.expand()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["rule_version"], 1)
        self.assertTrue(out["occurrences"])
        first = out["occurrences"][0]
        self.assertEqual(first["date"], "2024-01-31")
        self.assertEqual(first["utc"], "2024-01-31T14:30:00Z")  # 09:30 EST
        self.assertEqual(first["sources"], ["recurrence[cycle=0]"])
        self.assertTrue(first["steps"])
        utcs = [o["utc_epoch"] for o in out["occurrences"]]
        self.assertEqual(utcs, sorted(utcs))

    def test_holiday_adjustment_visible_via_cli(self):
        out = json.loads(self.expand().stdout)
        jan25 = [o for o in out["occurrences"] if o["date"] == "2025-01-31"]
        self.assertTrue(jan25)
        dec = [o for o in out["occurrences"]
               if o["date"].startswith("2025-01")][0]
        # 2024-12-31 is a holiday per the calendar file -> moved to 2025-01-02
        moved = [o for o in out["occurrences"] if o["date"] == "2025-01-02"]
        self.assertTrue(moved)
        self.assertTrue(any("New Year's Eve" in s for s in moved[0]["steps"]))

    def test_deterministic_output(self):
        self.assertEqual(self.expand().stdout, self.expand().stdout)

    def test_pagination_and_cursor_roundtrip(self):
        out1 = json.loads(self.expand("--page-size", "5").stdout)
        self.assertTrue(out1["has_more"])
        self.assertEqual(len(out1["occurrences"]), 5)
        out2 = json.loads(self.expand("--page-size", "5",
                                      "--cursor", out1["next_cursor"]).stdout)
        self.assertEqual(len(out2["occurrences"]), 5)
        all_utcs = ([o["utc_epoch"] for o in out1["occurrences"]]
                    + [o["utc_epoch"] for o in out2["occurrences"]])
        self.assertEqual(len(all_utcs), len(set(all_utcs)))

    def test_reverse_pagination(self):
        out = json.loads(self.expand("--page-size", "4", "--reverse").stdout)
        utcs = [o["utc_epoch"] for o in out["occurrences"]]
        self.assertEqual(utcs, sorted(utcs, reverse=True))
        self.assertEqual(out["direction"], "rev")

    def test_stale_cursor_rejected_with_exit_code_2(self):
        out1 = json.loads(self.expand("--page-size", "5").stdout)
        changed = dict(RULE, version=2, remove_dates=["2024-03-31"])
        new_path = Path(self.tmp.name) / "rule_v2.json"
        new_path.write_text(json.dumps(changed))
        proc = self.expand("--page-size", "5", "--cursor", out1["next_cursor"],
                           rule_path=new_path)
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stdout)
        self.assertEqual(err["error"], "CursorMismatch")

    def test_rule_from_stdin(self):
        proc = run_cli("expand", "--rule", "-",
                       "--start", "2024-01-01T00:00:00Z",
                       "--end", "2024-06-01T00:00:00Z",
                       stdin=json.dumps(RULE))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["occurrences"])

    def test_invalid_rule_exit_code_2(self):
        bad = Path(self.tmp.name) / "bad.json"
        bad.write_text(json.dumps(dict(RULE, day_of_month=32)))
        proc = self.expand(rule_path=bad)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["error"], "ValueError")


class TestCliVerify(CliCase):
    def test_verify_cross_check_ok(self):
        proc = run_cli("verify", "--rule", str(self.rule_path),
                       "--holidays", str(self.cal_path),
                       "--start-date", "2024-01-01",
                       "--end-date", "2025-12-31")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["ok"])
        self.assertGreater(out["reference_count"], 0)


if __name__ == "__main__":
    unittest.main()
