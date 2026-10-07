import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(store, command, payload):
    proc = subprocess.run(
        [sys.executable, "-m", "logfilter", "--store", store, command],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        cwd=REPO_ROOT,
    )
    out = json.loads(proc.stdout)
    return proc.returncode, out


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = os.path.join(self.tmp.name, "store.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_add_search_delete_stats_roundtrip(self):
        code, out = run_cli(self.store, "add", {"doc_id": "1", "text": "Hello, hello world!"})
        self.assertEqual(code, 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["num_terms"], 2)  # hello, world

        run_cli(self.store, "add", {"doc_id": "2", "terms": ["help", "hell"]})

        code, out = run_cli(self.store, "search", {"pattern": "hel*{~1}", "limit": 10})
        self.assertEqual(code, 0)
        self.assertTrue(out["ok"])
        self.assertTrue(out["complete"])
        docs = {entry["doc_id"] for entry in out["results"]}
        self.assertEqual(docs, {"1", "2"})
        hit = out["results"][0]["terms"][0]
        self.assertIn("alignment", hit)
        self.assertIn("distance", hit)

        code, out = run_cli(self.store, "stats", {})
        self.assertTrue(out["ok"])
        self.assertEqual(out["num_docs"], 2)
        self.assertGreater(out["automaton_nodes"], 1)

        code, out = run_cli(self.store, "delete", {"doc_id": "2"})
        self.assertTrue(out["removed"])
        code, out = run_cli(self.store, "search", {"pattern": "help", "limit": 10})
        self.assertEqual(out["results"], [])

    def test_invalid_pattern_rejected_atomically(self):
        run_cli(self.store, "add", {"doc_id": "1", "terms": ["abc"]})
        with open(self.store, "rb") as fh:
            before = fh.read()
        code, out = run_cli(self.store, "search", {"pattern": "[unterminated"})
        self.assertEqual(code, 2)
        self.assertFalse(out["ok"])
        self.assertIn("invalid pattern", out["error"])
        with open(self.store, "rb") as fh:
            after = fh.read()
        self.assertEqual(before, after, "rejected pattern must not touch the store")

    def test_pagination_via_cursor(self):
        for i in range(5):
            run_cli(self.store, "add", {"doc_id": str(i), "terms": [f"item{i}"]})
        code, first = run_cli(self.store, "search", {"pattern": "item*", "limit": 2})
        self.assertFalse(first["complete"])
        self.assertIsNotNone(first["cursor"])
        code, second = run_cli(
            self.store, "search", {"cursor": first["cursor"], "limit": 100}
        )
        self.assertTrue(second["complete"])
        docs = [e["doc_id"] for e in first["results"] + second["results"]]
        self.assertEqual(sorted(docs), ["0", "1", "2", "3", "4"])
        self.assertEqual(len(docs), len(set(docs)))

    def test_budget_gives_frontier_lower_bounds(self):
        run_cli(self.store, "add", {"doc_id": "1", "terms": ["alpha", "beta"]})
        code, out = run_cli(
            self.store, "search", {"pattern": "*", "limit": 100, "budget": 1}
        )
        self.assertFalse(out["complete"])
        self.assertTrue(out["frontier"])
        for entry in out["frontier"]:
            self.assertGreaterEqual(entry["distance_lower_bound"], 0)


if __name__ == "__main__":
    unittest.main()
