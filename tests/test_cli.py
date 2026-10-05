import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "ghtree"],
        input=json.dumps(request),
        capture_output=True, text=True, cwd=ROOT,
    )
    return proc.returncode, json.loads(proc.stdout)


class TestCli(unittest.TestCase):
    def test_build_query_update_verify_roundtrip(self):
        request = {
            "graph": {"vertices": ["a", "b", "c"],
                      "edges": [["a", "b", 4], ["b", "c", 4], ["a", "c", 4]]},
            "operations": [
                {"op": "query", "pairs": [["a", "b"], ["a", "c"]]},
                {"op": "update", "updates": [["a", "c", 0]]},
                {"op": "query", "pairs": [["a", "b"], ["b", "c"]]},
                {"op": "verify"},
            ],
        }
        code, out = run_cli(request)
        self.assertEqual(code, 0, out)
        self.assertTrue(out["ok"])
        first = out["results"][0]["results"]
        self.assertEqual([r["value"] for r in first], [8, 8])
        update = out["results"][1]
        self.assertTrue(update["ok"])
        self.assertEqual(len(update["report"]["reused"]) +
                         len(update["report"]["recomputed"]), 2)
        second = out["results"][2]["results"]
        self.assertEqual([r["value"] for r in second], [4, 4])
        # partitions are normalised: sides sorted, sides ordered
        part = second[0]["partition"]
        self.assertEqual(part, sorted([sorted(part[0]), sorted(part[1])]))
        self.assertTrue(out["results"][3]["verification"]["ok"])

        # feed the emitted state back in and continue
        code, out2 = run_cli({
            "state": out["state"],
            "operations": [
                {"op": "query", "pairs": [["a", "c"]]},
                {"op": "update", "updates": [["a", "c", 10]]},
                {"op": "query", "pairs": [["a", "c"]]},
                {"op": "verify"},
            ],
        })
        self.assertEqual(code, 0, out2)
        self.assertEqual(out2["results"][0]["results"][0]["value"], 4)
        self.assertEqual(out2["results"][2]["results"][0]["value"], 14)
        self.assertTrue(out2["results"][3]["verification"]["ok"])

    def test_illegal_update_reported_and_state_unchanged(self):
        request = {
            "graph": {"vertices": ["a", "b"],
                      "edges": [["a", "b", 5]]},
            "operations": [
                {"op": "update", "updates": [["a", "b", -3]]},
                {"op": "query", "pairs": [["a", "b"]]},
                {"op": "verify"},
            ],
        }
        code, out = run_cli(request)
        self.assertFalse(out["ok"])
        self.assertFalse(out["results"][0]["ok"])
        self.assertIn("capacity", out["results"][0]["error"])
        # rolled back: the old value still answers queries, tree verifies
        self.assertEqual(out["results"][1]["results"][0]["value"], 5)
        self.assertTrue(out["results"][2]["verification"]["ok"])

    def test_zero_capacity_and_parallel_edges_via_cli(self):
        request = {
            "graph": {"vertices": ["a", "b", "c", "d"],
                      "edges": [["a", "b", 2], ["a", "b", 3],
                                ["c", "d", 4], ["b", "c", 0],
                                ["a", "a", 9]]},
            "operations": [
                {"op": "query", "pairs": [["a", "b"], ["a", "d"]]},
                {"op": "verify"},
            ],
        }
        code, out = run_cli(request)
        self.assertEqual(code, 0, out)
        values = {tuple(r["pair"]): r["value"]
                  for r in out["results"][0]["results"]}
        self.assertEqual(values[("a", "b")], 5)
        self.assertEqual(values[("a", "d")], 0)
        self.assertTrue(out["results"][1]["verification"]["ok"])

    def test_bad_request(self):
        code, out = run_cli({"operations": []})
        self.assertFalse(out["ok"])
        code, out = run_cli({"graph": {"vertices": [], "edges": []}})
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
