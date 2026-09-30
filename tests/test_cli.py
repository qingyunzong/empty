import json
import os
import subprocess
import sys
import tempfile
import unittest


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmp.name, "db.json")

    def tearDown(self):
        self.tmp.cleanup()

    def write_db(self, db):
        with open(self.db_path, "w", encoding="utf-8") as handle:
            if isinstance(db, str):
                handle.write(db)
            else:
                json.dump(db, handle)

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "rbacx", *args],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_check_allow(self):
        self.write_db({"roles": {"r": {"allow": ["p"]}}, "users": {"u": ["r"]}})
        proc = self.run_cli("check", "--db", self.db_path, "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["decision"], "allow")
        self.assertEqual(out["sources"], {"allow": ["r"], "deny": []})
        self.assertEqual(out["epoch"], 0)

    def test_check_deny_empty_db(self):
        self.write_db({})
        proc = self.run_cli("check", "--db", self.db_path, "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["decision"], "deny")
        self.assertEqual(out["sources"], {"allow": [], "deny": []})

    def test_check_with_revocation_epoch(self):
        self.write_db(
            {
                "roles": {"r": {"allow": ["p"]}},
                "users": {"u": ["r"]},
                "revocations": [{"epoch": 4, "type": "role", "role": "r"}],
            }
        )
        proc = self.run_cli("check", "--db", self.db_path, "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out, {"decision": "deny", "epoch": 4, "sources": {"allow": [], "deny": []}})

    def test_invalid_json_exit_code_2(self):
        self.write_db("{broken")
        proc = self.run_cli("check", "--db", self.db_path, "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr)
        self.assertEqual(err["error"], "invalid_json")

    def test_schema_error_exit_code_2(self):
        self.write_db({"roles": {"r": {"inherits": ["ghost"]}}})
        proc = self.run_cli("check", "--db", self.db_path, "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr)
        self.assertEqual(err["error"], "unknown_role")

    def test_missing_db_exit_code_2(self):
        proc = self.run_cli("check", "--db", "/nonexistent/db.json", "--user", "u", "--perm", "p")
        self.assertEqual(proc.returncode, 2)
        err = json.loads(proc.stderr)
        self.assertEqual(err["error"], "db_unreadable")

    def test_missing_args_exit_code_2(self):
        proc = self.run_cli("check", "--db", self.db_path)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
