import json
import subprocess
import sys
import tempfile
import unittest


def run_cli(commands):
    proc = subprocess.run(
        [sys.executable, "-m", "dynhull"],
        input="\n".join(json.dumps(c) for c in commands) + "\n",
        capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines()]


class CliTest(unittest.TestCase):
    def test_session(self):
        with tempfile.NamedTemporaryFile("r+", suffix=".json") as fh:
            cmds = [
                {"op": "insert", "id": 1, "x": 0, "y": 0},
                {"op": "insert", "id": 2, "x": 4, "y": 0},
                {"op": "insert", "id": 3, "x": 2, "y": "3/2"},
                {"op": "hull"},
                {"op": "extreme", "dx": 1, "dy": 1},
                {"op": "tangent", "x": 10, "y": 0},
                {"op": "checkpoint"},
                {"op": "insert", "id": 4, "x": 2, "y": 100},
                {"op": "hull"},
                {"op": "rollback"},
                {"op": "hull"},
                {"op": "save", "path": fh.name},
                {"op": "delete", "id": 2},
                {"op": "load", "path": fh.name},
                {"op": "hull"},
                {"op": "verify"},
                {"op": "stats"},
            ]
            out = run_cli(cmds)
        self.assertTrue(all(r["ok"] for r in out), out)
        hull1 = out[3]["result"]
        self.assertEqual([v["id"] for v in hull1["vertices"]], [1, 2, 3])
        self.assertEqual(len(hull1["edges"]), 3)
        edge0 = hull1["edges"][0]
        self.assertEqual((edge0["a"], edge0["b"], edge0["c"]), ("0", "4", "0"))
        self.assertEqual(out[4]["result"]["point"]["id"], 2)
        tangents = out[5]["result"]["tangents"]
        self.assertEqual(tangents["right"]["id"], 3)
        self.assertEqual(tangents["left"]["id"], 1)
        hull_after_insert = out[8]["result"]
        # (2, 3/2) falls inside the new triangle: still 3 vertices
        self.assertEqual(len(hull_after_insert["vertices"]), 3)
        self.assertIn(4, [v["id"] for v in hull_after_insert["vertices"]])
        hull_after_rollback = out[10]["result"]
        self.assertEqual(hull_after_rollback, hull1)
        hull_after_load = out[14]["result"]
        self.assertEqual(hull_after_load, hull1)
        self.assertTrue(out[15]["result"]["valid"])
        self.assertGreater(out[16]["result"]["stats"]["created"], 0)

    def test_float_rejected_and_errors_recoverable(self):
        out = run_cli([
            {"op": "insert", "id": 1, "x": 1.5, "y": 0},
            {"op": "insert", "id": 1, "x": "3/2", "y": 0},
            {"op": "insert", "id": 1, "x": 0, "y": 0},
            {"op": "delete", "id": 42},
            {"op": "hull"},
            {"op": "bogus"},
            {"op": "verify"},
        ])
        self.assertFalse(out[0]["ok"])   # float rejected
        self.assertTrue(out[1]["ok"])
        self.assertFalse(out[2]["ok"])   # duplicate id
        self.assertFalse(out[3]["ok"])   # unknown id
        self.assertTrue(out[4]["ok"])
        self.assertFalse(out[5]["ok"])   # unknown op
        self.assertTrue(out[6]["ok"])    # server still alive


if __name__ == "__main__":
    unittest.main()
