import json
import os
import subprocess
import sys
import tempfile
import unittest

DOCS = [
    {"id": "d1", "doc": {"title": "the quick brown fox",
                          "tags": ["red fox", "blue whale"]}},
    {"id": "d2", "doc": {"title": "quick", "body": "a silver fox"}},
    {"id": "d3", "doc": {"title": "", "note": None}},
]


def run_cli(*args, expect_ok=True):
    proc = subprocess.run(
        [sys.executable, "-m", "docret", *args],
        capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    payload = json.loads(proc.stdout)
    if expect_ok:
        assert proc.returncode == 0, (proc.stdout, proc.stderr)
        assert payload.get("ok", True) is not False, payload
    else:
        assert proc.returncode != 0, (proc.stdout, proc.stderr)
    return payload


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.docs_path = os.path.join(self.tmp.name, "docs.jsonl")
        self.index_path = os.path.join(self.tmp.name, "index.json")
        with open(self.docs_path, "w", encoding="utf-8") as fh:
            for record in DOCS:
                fh.write(json.dumps(record) + "\n")
        run_cli("build", self.docs_path, self.index_path)

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_and_query(self):
        out = run_cli("query", self.index_path, '"quick brown"')
        self.assertEqual(out["docs"], ["d1"])
        hit = out["hits"][0]
        self.assertEqual(hit["doc"], "d1")
        ev = hit["evidence"][0]
        self.assertEqual(ev["field"], "title")
        self.assertEqual(ev["text"], "quick brown")
        self.assertEqual(ev["span"], [4, 15])

    def test_query_not_universe(self):
        out = run_cli("query", self.index_path, "NOT title:quick")
        self.assertEqual(out["docs"], ["d3"])
        self.assertEqual(out["kind"], "bool")

    def test_check_command(self):
        out = run_cli("check", self.index_path, "quick AND NOT brown")
        self.assertTrue(out["ok"])
        self.assertEqual(out["index_docs"], out["interpreter_docs"])

    def test_alias_and_query(self):
        run_cli("alias", self.index_path, "--set", "headline=title")
        out = run_cli("query", self.index_path, "headline:quick")
        self.assertEqual(out["docs"], ["d1", "d2"])

    def test_alias_cycle_rejected(self):
        run_cli("alias", self.index_path, "--set", "x=y")
        out = run_cli("alias", self.index_path, "--set", "y=x", expect_ok=False)
        self.assertIn("AliasError", out["error"])

    def test_batch_update_and_rollback(self):
        ops_path = os.path.join(self.tmp.name, "ops.json")
        with open(ops_path, "w", encoding="utf-8") as fh:
            json.dump([
                {"op": "move", "doc": "d1", "from": "title", "to": "headline"},
                {"op": "set", "doc": "d2", "path": "meta.lang", "value": "en"},
            ], fh)
        run_cli("batch", self.index_path, ops_path)
        out = run_cli("query", self.index_path, "headline:quick")
        self.assertEqual(out["docs"], ["d1"])
        out = run_cli("query", self.index_path, "meta.lang:en")
        self.assertEqual(out["docs"], ["d2"])

        # failing batch leaves the saved index untouched
        with open(ops_path, "w", encoding="utf-8") as fh:
            json.dump([
                {"op": "set", "doc": "d1", "path": "title", "value": "changed"},
                {"op": "remove_doc", "doc": "ghost"},
            ], fh)
        run_cli("batch", self.index_path, ops_path, expect_ok=False)
        out = run_cli("query", self.index_path, "changed")
        self.assertEqual(out["docs"], [])

    def test_stats(self):
        out = run_cli("stats", self.index_path)
        self.assertEqual(out["doc_count"], 3)
        self.assertIn("title", out["fields"])

    def test_bad_query_reports_error(self):
        out = run_cli("query", self.index_path, "AND OR", expect_ok=False)
        self.assertIn("QueryError", out["error"])


if __name__ == "__main__":
    unittest.main()
