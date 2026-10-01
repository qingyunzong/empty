import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name) / "store"

    def run_cli(self, requests):
        payload = "".join(json.dumps(r) + "\n" for r in requests)
        proc = subprocess.run(
            [sys.executable, "-m", "docstore", str(self.dir)],
            input=payload, capture_output=True, text=True,
            cwd=ROOT, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_session_roundtrip(self):
        out = self.run_cli([
            {"cmd": "create_index", "name": "byV", "path": "/arr/*/v"},
            {"cmd": "apply", "ops": [
                {"op": "add", "path": "/arr",
                 "value": [{"v": 2}, {"v": 1}]}]},
            {"cmd": "snapshot"},
            {"cmd": "apply", "ops": [
                {"op": "add", "path": "/arr/0", "value": {"v": 0}}]},
            {"cmd": "query", "filters": [{"index": "byV", "exists": True}],
             "sort_by": "byV"},
            {"cmd": "query", "filters": [{"index": "byV", "exists": True}],
             "snapshot": 1},
            {"cmd": "get", "path": "/arr/0/v"},
            {"cmd": "version"},
            {"cmd": "reclaim"},
            {"cmd": "release", "snapshot": 1},
        ])
        self.assertTrue(all(r["ok"] for r in out), out)
        self.assertEqual(out[1]["version"], 1)
        self.assertEqual(out[2]["snapshot"], 1)
        self.assertEqual(out[3]["version"], 2)
        self.assertEqual([r["value"] for r in out[4]["results"]], [0, 1, 2])
        snap_paths = sorted(r["path"] for r in out[5]["results"])
        self.assertEqual(snap_paths, ["/arr/0/v", "/arr/1/v"])
        self.assertEqual(out[6]["value"], 0)
        self.assertEqual(out[7]["version"], 2)
        self.assertEqual(out[8]["version"], 2)

    def test_error_reported_and_session_survives(self):
        out = self.run_cli([
            {"cmd": "apply", "ops": [
                {"op": "add", "path": "/a", "value": 1},
                {"op": "test", "path": "/a", "value": 999}]},
            {"cmd": "version"},
            {"cmd": "bogus"},
            {"cmd": "doc"},
        ])
        self.assertFalse(out[0]["ok"])
        self.assertIn("PatchError", out[0]["error"])
        self.assertEqual(out[1], {"ok": True, "version": 0})
        self.assertFalse(out[2]["ok"])
        self.assertEqual(out[3], {"ok": True, "doc": {}})

    def test_persistence_across_processes(self):
        self.run_cli([
            {"cmd": "create_index", "name": "byV", "path": "/arr/*/v"},
            {"cmd": "apply", "ops": [
                {"op": "add", "path": "/arr", "value": [{"v": 5}]}]},
        ])
        out = self.run_cli([
            {"cmd": "query", "filters": [{"index": "byV", "eq": 5}]},
            {"cmd": "version"},
        ])
        self.assertEqual(out[0]["results"],
                         [{"path": "/arr/0/v", "value": 5}])
        self.assertEqual(out[1]["version"], 1)


if __name__ == "__main__":
    unittest.main()
