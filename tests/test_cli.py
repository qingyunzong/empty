"""End-to-end tests for the JSON-lines CLI (python -m vgc)."""

import json
import subprocess
import sys
import unittest


def run_cli(lines, max_versions=3):
    payload = "".join(json.dumps(cmd) + "\n" for cmd in lines)
    proc = subprocess.run(
        [sys.executable, "-m", "vgc", "--max-versions", str(max_versions)],
        input=payload,
        capture_output=True,
        text=True,
        check=True,
    )
    return [json.loads(line) for line in proc.stdout.splitlines()]


class CliTest(unittest.TestCase):
    def test_full_session(self):
        replies = run_cli(
            [
                {"op": "begin", "txn": "t1"},
                {"op": "put", "txn": "t1", "key": "k", "value": "v1"},
                {"op": "commit", "txn": "t1"},
                {"op": "begin", "txn": "t_long"},
                {"op": "begin", "txn": "t2"},
                {"op": "put", "txn": "t2", "key": "k", "value": "v2"},
                {"op": "commit", "txn": "t2"},
                {"op": "as_of", "ts": 1, "key": "k"},
                {"op": "gc"},
                {"op": "commit", "txn": "t_long"},
                {"op": "gc"},
                {"op": "as_of", "ts": 1, "key": "k"},
                {"op": "stats"},
            ]
        )
        self.assertEqual(replies[0], {"ok": True, "snapshot_ts": 0})
        self.assertEqual(replies[2], {"ok": True, "commit_ts": 1})
        self.assertEqual(replies[3], {"ok": True, "snapshot_ts": 1})
        self.assertEqual(replies[6], {"ok": True, "commit_ts": 2})
        self.assertEqual(replies[7], {"ok": True, "found": True, "value": "v1"})
        self.assertTrue(replies[8]["ok"])
        self.assertEqual(replies[8]["status"], "GC_OK")
        self.assertEqual(replies[8]["reclaimed"], 0)
        self.assertEqual(replies[8]["low_watermark"], 1)
        self.assertEqual(replies[10]["reclaimed"], 1)
        self.assertEqual(replies[11]["ok"], False)
        self.assertEqual(replies[11]["error"], "SNAPSHOT_EXPIRED")
        stats = replies[12]["stats"]
        self.assertEqual(stats["versions"], 1)
        self.assertEqual(stats["reclaimed_total"], 1)
        self.assertEqual(stats["active_snapshots"], [])

    def test_errors_are_json_lines(self):
        replies = run_cli(
            [
                {"op": "commit", "txn": "nope"},
                {"op": "bogus"},
                {"op": "stats"},
            ]
        )
        self.assertFalse(replies[0]["ok"])
        self.assertIn("unknown transaction", replies[0]["error"])
        self.assertFalse(replies[1]["ok"])
        self.assertIn("unknown op", replies[1]["error"])
        self.assertTrue(replies[2]["ok"])


if __name__ == "__main__":
    unittest.main()
