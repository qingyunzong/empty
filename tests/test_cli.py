import json
import subprocess
import sys
import unittest


def run_cli(lines):
    proc = subprocess.run(
        [sys.executable, "-m", "intervalmap.cli"],
        input="\n".join(json.dumps(x) for x in lines) + "\n",
        capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines()]


class TestCli(unittest.TestCase):
    def test_add_and_intervals(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "0", "hi": "10"},
            {"op": "add", "source": "b", "lo": "1/2", "hi": "3/4"},
            {"op": "intervals"},
        ])
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(out[-1]["intervals"], [
            {"lo": "0", "hi": "1/2", "sources": {"a": 1}, "count": 1},
            {"lo": "1/2", "hi": "3/4", "sources": {"a": 1, "b": 1}, "count": 2},
            {"lo": "3/4", "hi": "10", "sources": {"a": 1}, "count": 1}])

    def test_threshold_and_check(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "0", "hi": "10"},
            {"op": "add", "source": "b", "lo": "2", "hi": "8"},
            {"op": "threshold", "k": 2},
            {"op": "check", "k": 2},
        ])
        self.assertEqual(out[2]["intervals"],
                         [{"lo": "2", "hi": "8", "sources": {"a": 1, "b": 1},
                           "count": 2}])
        self.assertEqual(out[3], {"ok": True, "check": "map+threshold"})

    def test_transactions_and_snapshots(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "0", "hi": "10"},
            {"op": "save", "name": "v0"},
            {"op": "begin"},
            {"op": "add", "source": "b", "lo": "0", "hi": "10"},
            {"op": "rollback"},
            {"op": "intervals"},
            {"op": "add", "source": "c", "lo": "20", "hi": "30"},
            {"op": "restore", "name": "v0"},
            {"op": "intervals"},
        ])
        self.assertEqual(out[5]["intervals"],
                         [{"lo": "0", "hi": "10", "sources": {"a": 1}, "count": 1}])
        self.assertEqual(out[8]["intervals"],
                         [{"lo": "0", "hi": "10", "sources": {"a": 1}, "count": 1}])

    def test_illegal_range_error_keeps_state(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "0", "hi": "10"},
            {"op": "add", "source": "b", "lo": "8", "hi": "3"},
            {"op": "intervals"},
            {"op": "check"},
        ])
        self.assertFalse(out[1]["ok"])
        self.assertIn("error", out[1])
        self.assertEqual(out[2]["intervals"],
                         [{"lo": "0", "hi": "10", "sources": {"a": 1}, "count": 1}])
        self.assertTrue(out[3]["ok"])

    def test_infinity_and_length(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "-inf", "hi": "+inf"},
            {"op": "length"},
            {"op": "remove_source", "source": "a", "lo": "5", "hi": "+inf"},
            {"op": "intervals"},
        ])
        self.assertEqual(out[1]["length"], "+inf")
        self.assertEqual(out[3]["intervals"],
                         [{"lo": "-inf", "hi": "5", "sources": {"a": 1}, "count": 1}])

    def test_set_ops_via_cli(self):
        out = run_cli([
            {"op": "add", "source": "a", "lo": "0", "hi": "10"},
            {"op": "intersection",
             "intervals": [{"source": "b", "lo": "5", "hi": "20"}]},
            {"op": "intervals"},
            {"op": "union",
             "intervals": [{"source": "c", "lo": "100", "hi": "110"}]},
            {"op": "intervals"},
        ])
        self.assertEqual(out[2]["intervals"],
                         [{"lo": "5", "hi": "10", "sources": {"a": 1, "b": 1},
                           "count": 2}])
        self.assertEqual(len(out[4]["intervals"]), 2)

    def test_unknown_op_and_bad_json(self):
        proc = subprocess.run(
            [sys.executable, "-m", "intervalmap.cli"],
            input='{"op":"nope"}\nnot json\n{"op":"intervals"}\n',
            capture_output=True, text=True, timeout=30)
        lines = [json.loads(x) for x in proc.stdout.splitlines()]
        self.assertFalse(lines[0]["ok"])
        self.assertFalse(lines[1]["ok"])
        self.assertTrue(lines[2]["ok"])


if __name__ == "__main__":
    unittest.main()
