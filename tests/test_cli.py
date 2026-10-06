import json
import subprocess
import sys
import unittest

from tzhelpers import L, dst_table

DST_TABLE_JSON = {
    "segments": [
        {"id": "winter-before", "utc_start": None,
         "utc_end": "2024-03-31T01:00:00Z", "offset_seconds": 0},
        {"id": "summer", "utc_start": "2024-03-31T01:00:00Z",
         "utc_end": "2024-10-27T01:00:00Z", "offset_seconds": 3600},
        {"id": "winter-after", "utc_start": "2024-10-27T01:00:00Z",
         "utc_end": None, "offset_seconds": 0},
    ]
}


def run_cli(request: dict):
    proc = subprocess.run(
        [sys.executable, "-m", "timeline"],
        input=json.dumps(request), capture_output=True, text=True)
    return proc.returncode, json.loads(proc.stdout)


class CliTest(unittest.TestCase):
    def test_local_to_instant_gap(self):
        code, out = run_cli({
            "command": "local_to_instant", "table": DST_TABLE_JSON,
            "local": "2024-03-31T01:30:00"})
        self.assertEqual(code, 0)
        self.assertEqual(out["count"], 0)
        self.assertEqual(out["candidates"], [])

    def test_local_to_instant_fold(self):
        code, out = run_cli({
            "command": "local_to_instant", "table": DST_TABLE_JSON,
            "local": "2024-10-27T01:30:00"})
        self.assertEqual(code, 0)
        self.assertEqual(out["count"], 2)
        instants = [c["instant"] for c in out["candidates"]]
        self.assertEqual(instants,
                         ["2024-10-27T00:30:00Z", "2024-10-27T01:30:00Z"])
        self.assertEqual(out["candidates"][0]["evidence"]["segment_id"],
                         "summer")

    def test_instant_to_local(self):
        code, out = run_cli({
            "command": "instant_to_local", "table": DST_TABLE_JSON,
            "instant": "2024-10-27T00:30:00Z"})
        self.assertEqual(code, 0)
        self.assertEqual(out["local"], "2024-10-27T01:30:00")
        self.assertEqual(out["segment_id"], "summer")

    def test_convert_interval_across_gap(self):
        code, out = run_cli({
            "command": "convert_interval", "table": DST_TABLE_JSON,
            "interval": {"start": "2024-03-31T00:30:00",
                         "end": "2024-03-31T02:30:00"}})
        self.assertEqual(code, 0)
        self.assertEqual(len(out["pieces"]), 2)
        # the reported gap is exactly the missing local hour 01:00-02:00
        self.assertEqual(out["gaps"],
                         [[L(2024, 3, 31, 1, 0), L(2024, 3, 31, 2, 0)]])

    def test_convert_interval_across_fold_marks_duplicates(self):
        code, out = run_cli({
            "command": "convert_interval", "table": DST_TABLE_JSON,
            "interval": {"start": "2024-10-27T00:30:00",
                         "end": "2024-10-27T02:30:00"}})
        self.assertEqual(code, 0)
        self.assertEqual(len(out["pieces"]), 2)
        self.assertTrue(all(p["duplicate"] for p in out["pieces"]))

    def test_add_days_vs_add_seconds(self):
        code, out = run_cli({"command": "add_days",
                             "local": "2024-03-30T12:00:00", "days": 1})
        self.assertEqual(out["local"], "2024-03-31T12:00:00")
        code, out = run_cli({"command": "add_seconds",
                             "instant": "2024-03-30T12:00:00Z",
                             "seconds": 86400})
        self.assertEqual(out["instant"], "2024-03-31T12:00:00Z")

    def test_add_months_clamps(self):
        code, out = run_cli({"command": "add_months",
                             "local": "2024-01-31T10:00:00", "months": 1})
        self.assertEqual(out["local"], "2024-02-29T10:00:00")

    def test_revise_applies_atomically(self):
        code, out = run_cli({
            "command": "revise", "table": DST_TABLE_JSON,
            "revision": [
                {"id": "summer-v2", "utc_start": "2024-03-31T01:00:00Z",
                 "utc_end": "2024-10-27T01:00:00Z", "offset_seconds": 9000},
            ]})
        self.assertEqual(code, 0)
        self.assertTrue(out["applied"])
        self.assertEqual(out["table"]["version"], 2)
        offsets = [s["offset_seconds"] for s in out["table"]["segments"]]
        self.assertEqual(offsets, [0, 9000, 0])

    def test_revise_overlap_rejected(self):
        code, out = run_cli({
            "command": "revise", "table": DST_TABLE_JSON,
            "revision": [
                {"id": "x", "utc_start": "2024-03-31T01:00:00Z",
                 "utc_end": "2024-09-01T00:00:00Z", "offset_seconds": 3600},
                {"id": "y", "utc_start": "2024-08-01T00:00:00Z",
                 "utc_end": None, "offset_seconds": 0},
            ]})
        self.assertEqual(code, 1)
        self.assertFalse(out["ok"])
        self.assertIn("overlap", out["error"])

    def test_invalid_table_rejected(self):
        code, out = run_cli({"command": "validate_table", "table": {
            "segments": [
                {"id": "a", "utc_start": None,
                 "utc_end": "2024-06-01T00:00:00Z", "offset_seconds": 0},
                {"id": "b", "utc_start": "2024-05-01T00:00:00Z",
                 "utc_end": None, "offset_seconds": 3600},
            ]}})
        self.assertEqual(code, 1)
        self.assertIn("overlap", out["error"])

    def test_unknown_command(self):
        code, out = run_cli({"command": "nonsense"})
        self.assertEqual(code, 1)
        self.assertIn("unknown command", out["error"])


if __name__ == "__main__":
    unittest.main()
