import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(commands):
    proc = subprocess.run(
        [sys.executable, "-m", "intervalmap"],
        input=json.dumps(commands), capture_output=True, text=True,
        cwd=ROOT, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_add_query_flow(self):
        out = run_cli([
            {"op": "add", "lo": "0", "hi": "3/2", "source": "a"},
            {"op": "add", "lo": "1", "hi": "2", "source": "b"},
            {"op": "segments"},
            {"op": "threshold", "k": 2},
            {"op": "sources_at", "x": "5/4"},
            {"op": "total_length"},
            {"op": "refcount", "source": "a"},
            {"op": "check"},
        ])
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(out[2]["segments"], [
            {"lo": "0", "hi": "1", "sources": {"a": 1}},
            {"lo": "1", "hi": "3/2", "sources": {"a": 1, "b": 1}},
            {"lo": "3/2", "hi": "2", "sources": {"b": 1}},
        ])
        self.assertEqual(out[3]["intervals"], [
            {"lo": "1", "hi": "3/2", "sources": {"a": 1, "b": 1}}])
        self.assertTrue(out[3]["verified"])
        self.assertEqual(out[3]["total_length"], "1/2")
        self.assertEqual(out[4]["sources"], {"a": 1, "b": 1})
        self.assertEqual(out[5]["total_length"], "2")
        self.assertEqual(out[6]["refcount"], 2)  # a covers two segments
        self.assertTrue(out[7]["verified"])

    def test_invalid_order_reports_error_and_preserves_state(self):
        out = run_cli([
            {"op": "add", "lo": "0", "hi": "5", "source": "a"},
            {"op": "add", "lo": "4", "hi": "1", "source": "b"},
            {"op": "segments"},
        ])
        self.assertTrue(out[0]["ok"])
        self.assertFalse(out[1]["ok"])
        self.assertIn("ValueError", out[1]["error"])
        self.assertEqual(out[2]["segments"],
                         [{"lo": "0", "hi": "5", "sources": {"a": 1}}])

    def test_transactions_snapshots_and_infinite_endpoints(self):
        out = run_cli([
            {"op": "add", "lo": "-inf", "hi": "0", "source": "a"},
            {"op": "snapshot", "name": "s0"},
            {"op": "begin"},
            {"op": "add", "lo": "0", "hi": "inf", "source": "a"},
            {"op": "rollback"},
            {"op": "segments"},
            {"op": "restore", "name": "s0"},
            {"op": "add", "lo": "10", "hi": "20", "source": "b"},
            {"op": "total_length"},
        ])
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(out[5]["segments"],
                         [{"lo": "-inf", "hi": "0", "sources": {"a": 1}}])
        self.assertEqual(out[8]["total_length"], "inf")

    def test_save_and_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "map.json")
            out = run_cli([
                {"op": "add", "lo": "0", "hi": "3", "source": "a"},
                {"op": "add", "lo": "1", "hi": "4", "source": "b"},
                {"op": "save", "path": path},
            ])
            self.assertTrue(all(r["ok"] for r in out))
            out2 = run_cli([
                {"op": "load", "path": path},
                {"op": "segments"},
                {"op": "check"},
            ])
            self.assertEqual(out2[1]["segments"], [
                {"lo": "0", "hi": "1", "sources": {"a": 1}},
                {"lo": "1", "hi": "3", "sources": {"a": 1, "b": 1}},
                {"lo": "3", "hi": "4", "sources": {"b": 1}},
            ])
            self.assertTrue(out2[2]["verified"])

    def test_union_difference_via_cli(self):
        other = {"segments": [{"lo": "2", "hi": "6", "sources": {"b": 1}}]}
        out = run_cli([
            {"op": "add", "lo": "0", "hi": "4", "source": "a"},
            {"op": "union", "map": other},
            {"op": "difference", "map": other},
            {"op": "segments"},
        ])
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(out[3]["segments"],
                         [{"lo": "0", "hi": "2", "sources": {"a": 1}}])


if __name__ == "__main__":
    unittest.main()
