import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "docindex.cli", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


class TestCli(unittest.TestCase):
    def test_run_script_end_to_end(self):
        script = [
            {"cmd": "add", "doc_id": "d1", "doc": {"title": "the quick brown fox", "tags": ["quick brown", "fox"]}},
            {"cmd": "add", "doc_id": "d2", "doc": {"title": "quick", "body": "brown"}},
            {"cmd": "query", "q": 'tags[*]:"quick brown"'},
            {"cmd": "query", "q": "NOT title:fox"},
            {"cmd": "alias", "rules": {"headline": ["title"]}},
            {"cmd": "query", "q": "headline:fox"},
            {"cmd": "batch", "ops": [{"op": "move_field", "doc_id": "d2", "from": "body", "to": "text"}]},
            {"cmd": "query", "q": "text:brown"},
            {"cmd": "snapshot", "name": "s1"},
            {"cmd": "add", "doc_id": "d3", "doc": {"title": "late fox"}},
            {"cmd": "query", "q": "title:fox", "snapshot": "s1"},
            {"cmd": "stats"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "script.json")
            store = os.path.join(tmp, "store.json")
            with open(script_path, "w", encoding="utf-8") as fh:
                json.dump(script, fh)
            proc = run_cli("--store", store, "run", "--script", script_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            results = json.loads(proc.stdout)
            self.assertTrue(all(r["ok"] for r in results))

            phrase = results[2]["result"]
            self.assertEqual(phrase["kind"], "pos")
            self.assertEqual(phrase["doc_ids"], ["d1"])
            self.assertEqual(phrase["hits"][0]["field"], "tags[0]")
            self.assertEqual(phrase["hits"][0]["text"], "quick brown")

            self.assertEqual(results[3]["result"]["doc_ids"], ["d2"])  # NOT universe
            self.assertEqual(results[5]["result"]["doc_ids"], ["d1"])  # alias
            self.assertEqual(results[7]["result"]["doc_ids"], ["d2"])  # moved field
            self.assertEqual(results[10]["result"]["doc_ids"], ["d1"])  # snapshot frozen
            self.assertEqual(results[11]["result"]["num_docs"], 3)

            # store persists across invocations
            proc2 = run_cli("--store", store, "query", "--q", "title:fox")
            self.assertEqual(proc2.returncode, 0, proc2.stderr)
            payload = json.loads(proc2.stdout)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["result"]["doc_ids"], ["d1", "d3"])

    def test_single_commands_and_error_reporting(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = os.path.join(tmp, "store.json")
            proc = run_cli("--store", store, "add", "--doc-id", "d1", "--doc", '{"title": "hello world"}')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(json.loads(proc.stdout)["ok"])

            proc = run_cli("--store", store, "query", "--q", 'title:"hello world"')
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["result"]["hits"][0]["span"], [0, 11])

            proc = run_cli("--store", store, "query", "--q", "(broken")
            self.assertEqual(proc.returncode, 1)
            self.assertFalse(json.loads(proc.stdout)["ok"])

    def test_run_script_stops_on_error(self):
        script = [
            {"cmd": "add", "doc_id": "d1", "doc": {"title": "x"}},
            {"cmd": "batch", "ops": [{"op": "delete_doc", "doc_id": "ghost"}]},
            {"cmd": "stats"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            script_path = os.path.join(tmp, "script.json")
            with open(script_path, "w", encoding="utf-8") as fh:
                json.dump(script, fh)
            proc = run_cli("run", "--script", script_path)
            self.assertEqual(proc.returncode, 1)
            results = json.loads(proc.stdout)
            self.assertEqual(len(results), 2)
            self.assertFalse(results[1]["ok"])
            self.assertIn("BatchError", results[1]["error"])


if __name__ == "__main__":
    unittest.main()
