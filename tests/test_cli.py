import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(commands):
    """Feed command dicts as JSON lines to `python -m secidx`; return responses."""
    proc = subprocess.run(
        [sys.executable, "-m", "secidx"],
        input="".join(json.dumps(c) + "\n" for c in commands),
        capture_output=True, text=True, cwd=ROOT, timeout=30,
    )
    assert proc.returncode == 0, proc.stderr
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


class CliTest(unittest.TestCase):
    def test_basic_session(self):
        resp = run_cli([
            {"op": "create_index", "name": "by_email", "field": "email",
             "unique": True},
            {"op": "create_index", "name": "by_age", "field": "age"},
            {"op": "begin"},
            {"op": "insert", "txn": 1, "pk": "u1",
             "fields": {"email": "a@x", "age": 30}},
            {"op": "commit", "txn": 1},
            {"op": "find", "index": "by_email", "key": "a@x"},
            {"op": "find", "index": "by_email", "key": "nobody@x"},
            {"op": "scan", "index": "by_age", "start": 18, "end": 40},
        ])
        self.assertEqual(resp[0], {"ok": True, "index": "by_email",
                                   "field": "email", "unique": True})
        self.assertEqual(resp[2], {"ok": True, "txn": 1})
        self.assertEqual(resp[3], {"ok": True})
        self.assertEqual(resp[5]["rows"],
                         [{"pk": "u1", "fields": {"email": "a@x", "age": 30}}])
        # acceptance (d): empty result is [], not an error
        self.assertEqual(resp[6], {"ok": True, "rows": []})
        self.assertEqual([r["pk"] for r in resp[7]["rows"]], ["u1"])

    def test_unique_violation_over_cli(self):
        resp = run_cli([
            {"op": "create_index", "name": "by_email", "field": "email",
             "unique": True},
            {"op": "begin"},
            {"op": "insert", "txn": 1, "pk": "u1", "fields": {"email": "a@x"}},
            {"op": "insert", "txn": 1, "pk": "u2", "fields": {"email": "a@x"}},
            {"op": "commit", "txn": 1},
            {"op": "find", "index": "by_email", "key": "a@x"},
        ])
        self.assertTrue(resp[2]["ok"])
        self.assertFalse(resp[3]["ok"])
        self.assertEqual(resp[3]["error"], "UNIQUE_VIOLATION")
        # txn was rolled back: commit fails, nothing is visible
        self.assertFalse(resp[4]["ok"])
        self.assertEqual(resp[5], {"ok": True, "rows": []})

    def test_interleaved_txns_over_cli(self):
        resp = run_cli([
            {"op": "create_index", "name": "by_email", "field": "email",
             "unique": True},
            {"op": "begin"},                      # txn 1
            {"op": "begin"},                      # txn 2
            {"op": "insert", "txn": 1, "pk": "u1", "fields": {"email": "d@x"}},
            {"op": "insert", "txn": 2, "pk": "u2", "fields": {"email": "d@x"}},
            {"op": "commit", "txn": 1},
            {"op": "commit", "txn": 2},
            {"op": "find", "index": "by_email", "key": "d@x"},
        ])
        self.assertTrue(resp[5]["ok"])
        self.assertEqual(resp[6]["error"], "UNIQUE_VIOLATION")
        self.assertEqual([r["pk"] for r in resp[7]["rows"]], ["u1"])

    def test_abort_and_update_over_cli(self):
        resp = run_cli([
            {"op": "create_index", "name": "by_email", "field": "email",
             "unique": True},
            {"op": "begin"},
            {"op": "insert", "txn": 1, "pk": "u1", "fields": {"email": "a@x"}},
            {"op": "abort", "txn": 1},
            {"op": "find", "index": "by_email", "key": "a@x"},
            {"op": "begin"},
            {"op": "insert", "txn": 2, "pk": "u1", "fields": {"email": "a@x"}},
            {"op": "commit", "txn": 2},
            {"op": "begin"},
            {"op": "update", "txn": 3, "pk": "u1", "fields": {"email": "b@x"}},
            {"op": "commit", "txn": 3},
            {"op": "find", "index": "by_email", "key": "a@x"},
            {"op": "find", "index": "by_email", "key": "b@x"},
        ])
        self.assertEqual(resp[4], {"ok": True, "rows": []})   # abort erased it
        self.assertEqual(resp[11], {"ok": True, "rows": []})  # old key gone
        self.assertEqual([r["pk"] for r in resp[12]["rows"]], ["u1"])

    def test_malformed_and_unknown_commands(self):
        proc = subprocess.run(
            [sys.executable, "-m", "secidx"],
            input='{"op": "nope"}\nnot json\n{"op": "begin"}\n',
            capture_output=True, text=True, cwd=ROOT, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual(lines[0]["error"], "BAD_REQUEST")
        self.assertEqual(lines[1]["error"], "BAD_JSON")
        self.assertTrue(lines[2]["ok"])


if __name__ == "__main__":
    unittest.main()
