"""End-to-end test of the JSON CLI, including the recovery trace."""

import json
import os
import subprocess
import sys
import tempfile
import unittest


class CliTest(unittest.TestCase):
    def test_cli_recovery_trace_with_reasons(self):
        repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        dbdir = tempfile.mkdtemp(prefix="kvcli-test-")
        script = {
            "dir": dbdir,
            "config": {"num_pages": 16, "page_size": 256, "pool_capacity": 4},
            "actions": [
                {"op": "begin"},
                {"op": "put", "tx": 1, "key": "a", "value": "1"},
                {"op": "commit", "tx": 1},
                {"op": "begin"},
                {"op": "put", "tx": 2, "key": "b", "value": "2"},
                {"op": "checkpoint"},
                {"op": "crash"},
                {"op": "recover"},
                {"op": "dump"},
            ],
        }
        proc = subprocess.run(
            [sys.executable, "-m", "kvstore.cli"],
            input=json.dumps(script), capture_output=True, text=True,
            cwd=repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        results = {r["op"]: r for r in out["results"]}
        self.assertEqual(results["dump"]["data"], {"a": "1"})
        trace = results["recover"]["trace"]
        self.assertTrue(trace, "recovery must emit a trace")
        for event in trace:
            self.assertIn("reason", event)
            self.assertTrue(event["reason"])
        phases = {e["phase"] for e in trace}
        self.assertIn("analysis", phases)
        self.assertIn("undo", phases)  # txn 2 was a loser
        self.assertTrue(any(e["action"] == "clr" for e in trace))

    def test_cli_reports_mid_log_corruption(self):
        repo = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        dbdir = tempfile.mkdtemp(prefix="kvcli-test-")
        seed = {"dir": dbdir, "actions": [
            {"op": "begin"},
            {"op": "put", "tx": 1, "key": "a", "value": "1"},
            {"op": "commit", "tx": 1},
            {"op": "begin"},
            {"op": "put", "tx": 2, "key": "b", "value": "2"},
            {"op": "commit", "tx": 2},
        ]}
        proc = subprocess.run([sys.executable, "-m", "kvstore.cli"],
                              input=json.dumps(seed), capture_output=True,
                              text=True, cwd=repo)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        wal = os.path.join(dbdir, "wal.log")
        with open(wal, "r+b") as fh:
            data = bytearray(fh.read())
            data[10] ^= 0xFF  # corrupt the first record (more follow)
            fh.seek(0)
            fh.write(bytes(data))
        proc = subprocess.run(
            [sys.executable, "-m", "kvstore.cli"],
            input=json.dumps({"dir": dbdir, "actions": [{"op": "dump"}]}),
            capture_output=True, text=True, cwd=repo)
        out = json.loads(proc.stdout)
        self.assertIn("CorruptLogError",
                      out["results"][0].get("error", ""))


if __name__ == "__main__":
    unittest.main()
