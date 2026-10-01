import json
import os
import subprocess
import sys
import tempfile
import unittest

CLI = [sys.executable, "-m", "knnindex.cli"]


def run_cli(*args):
    proc = subprocess.run(
        CLI + list(args), capture_output=True, text=True, check=False
    )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise AssertionError(f"non-JSON output: {proc.stdout!r} stderr={proc.stderr!r}")
    return proc.returncode, payload


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "idx.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_workflow(self):
        code, out = run_cli("create", "--db", self.db, "--dims", "2")
        self.assertEqual(code, 0)
        self.assertTrue(out["ok"])

        run_cli("insert", "--db", self.db, "--id", "a", "--coords", "0,0", "--labels", "x,y")
        run_cli("insert", "--db", self.db, "--id", "b", "--coords", "3/2,1", "--labels", "y")
        run_cli("insert", "--db", self.db, "--id", "c", "--coords", "10,10", "--labels", "x")

        code, out = run_cli("query", "--db", self.db, "--coords", "0,0", "--k", "2")
        self.assertEqual([h["id"] for h in out["hits"]], ["a", "b"])
        self.assertEqual(out["hits"][1]["dist2"], "13/4")
        self.assertEqual(out["status"], "complete")

        code, out = run_cli(
            "query", "--db", self.db, "--coords", "0,0", "--k", "2",
            "--filter", '{"tag": "x"}',
        )
        self.assertEqual([h["id"] for h in out["hits"]], ["a", "c"])

        code, out = run_cli("verify", "--db", self.db, "--coords", "0,0", "--k", "2")
        self.assertTrue(out["ok"], out["problems"])

        code, out = run_cli("replace", "--db", self.db, "--id", "c",
                            "--coords", "1/2,1/2", "--labels", "z")
        self.assertTrue(out["ok"])
        code, out = run_cli("query", "--db", self.db, "--coords", "0,0", "--k", "1")
        self.assertEqual(out["hits"][0]["id"], "a")

        code, out = run_cli("delete", "--db", self.db, "--id", "a")
        self.assertTrue(out["ok"])
        code, out = run_cli("query", "--db", self.db, "--coords", "0,0", "--k", "1")
        self.assertEqual(out["hits"][0]["id"], "c")

    def test_budget_cursor_resume_roundtrip(self):
        run_cli("create", "--db", self.db, "--dims", "1", "--capacity", "4")
        for i in range(40):
            run_cli("insert", "--db", self.db, "--id", f"p{i}", "--coords", str(i))
        code, out = run_cli("query", "--db", self.db, "--coords", "0", "--k", "3",
                            "--budget", "2")
        self.assertEqual(out["status"], "unknown")
        self.assertIn("cursor", out)
        cursor_path = os.path.join(self.tmp.name, "cursor.json")
        with open(cursor_path, "w") as fh:
            json.dump(out["cursor"], fh)
        code, out = run_cli("resume", "--db", self.db, "--cursor", cursor_path)
        self.assertEqual(out["status"], "complete")
        self.assertTrue(out["resumed"])
        self.assertEqual([h["id"] for h in out["hits"]], ["p0", "p1", "p2"])

    def test_cursor_rejected_after_mutation(self):
        run_cli("create", "--db", self.db, "--dims", "1", "--capacity", "4")
        for i in range(40):
            run_cli("insert", "--db", self.db, "--id", f"p{i}", "--coords", str(i))
        _, out = run_cli("query", "--db", self.db, "--coords", "0", "--k", "3",
                         "--budget", "2")
        cursor_path = os.path.join(self.tmp.name, "cursor.json")
        with open(cursor_path, "w") as fh:
            json.dump(out["cursor"], fh)
        run_cli("insert", "--db", self.db, "--id", "extra", "--coords", "1")
        code, out = run_cli("resume", "--db", self.db, "--cursor", cursor_path)
        self.assertFalse(out["ok"])
        self.assertIn("version", out["error"])

    def test_snapshot_via_cli(self):
        run_cli("create", "--db", self.db, "--dims", "1")
        run_cli("insert", "--db", self.db, "--id", "a", "--coords", "5")
        _, out = run_cli("snapshot", "--db", self.db)
        snap = out["snapshot"]
        run_cli("delete", "--db", self.db, "--id", "a")
        _, out = run_cli("query", "--db", self.db, "--coords", "0", "--k", "1",
                         "--version", str(snap))
        self.assertEqual(out["hits"][0]["id"], "a")
        _, out = run_cli("query", "--db", self.db, "--coords", "0", "--k", "1")
        self.assertEqual(out["hits"], [])

    def test_error_is_json(self):
        code, out = run_cli("query", "--db", self.db, "--coords", "0", "--k", "1")
        self.assertFalse(out["ok"])
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
