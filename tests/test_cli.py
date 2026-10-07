import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args, input_text=None):
    return subprocess.run(
        [sys.executable, "-m", "ghtree", *args],
        capture_output=True, text=True, cwd=ROOT, input=input_text)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.graph_path = os.path.join(self.tmp.name, "graph.json")
        self.state_path = os.path.join(self.tmp.name, "state.json")
        graph = {"n": 4,
                 "edges": [[0, 1, 8], [1, 2, 3], [2, 3, 8],
                           {"u": 0, "v": 3, "capacity": 1},
                           [0, 0, 5],          # self-loop ignored
                           [1, 2, 2]]}         # parallel edge aggregated
        with open(self.graph_path, "w") as fh:
            json.dump(graph, fh)

    def build(self):
        result = run_cli("build", "--graph", self.graph_path,
                         "--save", self.state_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def query(self, pairs):
        result = run_cli("query", "--state", self.state_path,
                         "--pairs", json.dumps(pairs))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["values"]

    def test_build_query_update_verify_roundtrip(self):
        summary = self.build()
        self.assertTrue(summary["ok"])
        self.assertEqual(summary["tree_edges"], 3)

        # Parallel edges (1,2): 3 + 2 = 5; min cuts all route via {0,1}.
        self.assertEqual(self.query([[0, 3], [0, 2], [1, 3], [0, 0]]),
                         [6, 6, 6, None])

        result = run_cli("verify", "--state", self.state_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "errors": []})

        updates = [{"u": 1, "v": 2, "capacity": 10}, [0, 3, 6]]
        result = run_cli("update", "--state", self.state_path,
                         "--updates", json.dumps(updates),
                         "--save", self.state_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertIn("reused", report)
        self.assertIn("resolved", report)
        self.assertIn("rebuilt", report)
        self.assertEqual(self.query([[0, 3]]), [14])

        result = run_cli("verify", "--state", self.state_path)
        self.assertEqual(json.loads(result.stdout)["ok"], True)

    def test_build_from_stdin(self):
        with open(self.graph_path) as fh:
            result = run_cli("build", input_text=fh.read())
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(result.stdout)
        self.assertEqual(state["n"], 4)
        self.assertEqual(len(state["tree"]), 3)

    def test_illegal_update_fails_and_preserves_state(self):
        self.build()
        with open(self.state_path) as fh:
            before = fh.read()
        result = run_cli("update", "--state", self.state_path,
                         "--updates", json.dumps([[0, 1, -2]]),
                         "--save", self.state_path)
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", json.loads(result.stderr))
        with open(self.state_path) as fh:
            self.assertEqual(fh.read(), before)
        self.assertEqual(self.query([[0, 3]]), [6])

    def test_verify_detects_tampered_state_file(self):
        self.build()
        with open(self.state_path) as fh:
            state = json.load(fh)
        state["tree"][0]["value"] += 1
        with open(self.state_path, "w") as fh:
            json.dump(state, fh)
        result = run_cli("verify", "--state", self.state_path)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
