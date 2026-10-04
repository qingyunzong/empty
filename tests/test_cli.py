import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    env = dict(os.environ, PYTHONPATH=ROOT + os.pathsep + os.environ.get("PYTHONPATH", ""))
    return subprocess.run(
        [sys.executable, "-m", "logfilter", *args],
        capture_output=True, text=True, cwd=ROOT, env=env,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.index = os.path.join(self.tmp.name, "idx.json")

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, doc, text):
        proc = run_cli(self.index, "add", doc, text)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_add_search_delete_stats(self):
        out = self.add("d1", "error warning error")
        self.assertTrue(out["ok"])
        self.assertEqual(out["stats"]["documents"], 1)
        self.add("d2", "errror error")

        proc = run_cli(self.index, "search", "error~1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["complete"])
        hits = {h["word"]: h for h in out["results"]}
        self.assertEqual(sorted(hits), ["error", "errror"])
        self.assertEqual(hits["error"]["docs"], ["d1", "d2"])
        self.assertEqual(out["documents"], ["d1", "d2"])
        # alignment evidence is present in CLI output
        self.assertEqual(hits["errror"]["alignment"]["edits"], 1)

        proc = run_cli(self.index, "delete", "d2")
        out = json.loads(proc.stdout)
        self.assertTrue(out["deleted"])
        proc = run_cli(self.index, "search", "error~1")
        hits = {h["word"] for h in json.loads(proc.stdout)["results"]}
        self.assertEqual(hits, {"error"})

        proc = run_cli(self.index, "stats")
        out = json.loads(proc.stdout)
        self.assertEqual(out["stats"]["distinct_terms"], 2)

    def test_pagination_via_cli(self):
        self.add("d1", "alpha beta gamma delta epsilon")
        proc = run_cli(self.index, "search", "*", "--limit", "2")
        page1 = json.loads(proc.stdout)
        self.assertFalse(page1["complete"])
        self.assertEqual(len(page1["results"]), 2)
        cursor = json.dumps(page1["cursor"])
        proc = run_cli(self.index, "search", "*", "--limit", "2", "--cursor", cursor)
        page2 = json.loads(proc.stdout)
        self.assertEqual(len(page2["results"]), 2)
        seen = [h["word"] for h in page1["results"] + page2["results"]]
        self.assertEqual(len(seen), len(set(seen)))

    def test_illegal_pattern_rejected_atomically(self):
        self.add("d1", "error warning")
        with open(self.index, "rb") as fh:
            before = fh.read()
        for bad in ("error~3", "err[or", "err]or", "err\\"):
            proc = run_cli(self.index, "search", bad)
            self.assertEqual(proc.returncode, 2, bad)
            out = json.loads(proc.stdout)
            self.assertEqual(out["error"]["type"], "PatternError")
        with open(self.index, "rb") as fh:
            after = fh.read()
        self.assertEqual(before, after)  # index untouched

    def test_budget_incomplete_via_cli(self):
        self.add("d1", "alpha beta gamma delta epsilon zeta eta theta")
        proc = run_cli(self.index, "search", "*", "--budget", "1")
        out = json.loads(proc.stdout)
        self.assertFalse(out["complete"])
        self.assertIsNotNone(out["cursor"])
        self.assertIsNotNone(out["stats"]["frontier_lower_bound"])

    def test_rules_version_mismatch(self):
        self.add("d1", "Foo")
        proc = run_cli(self.index, "--rules", "identity-v0", "add", "d2", "Bar")
        out = json.loads(proc.stdout)
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(out["error"]["type"], "VersionMismatchError")


if __name__ == "__main__":
    unittest.main()
