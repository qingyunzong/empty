import json
import os
import subprocess
import sys
import tempfile
import unittest

from symdfa import SymbolicDFA

DFA = {
    "alphabet_size": 2,
    "num_states": 6,
    "start": 0,
    "finals": [2, 5],
    "transitions": [
        [{"intervals": [[0, 0]], "target": 1}, {"intervals": [[1, 1]], "target": 3}],
        [{"intervals": [[0, 0]], "target": 2}],
        [{"intervals": [[0, 1]], "target": 2}],
        [{"intervals": [[0, 0]], "target": 4}],
        [{"intervals": [[0, 0]], "target": 5}],
        [{"intervals": [[0, 1]], "target": 5}],
    ],
}


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dfa_path = os.path.join(self.tmp.name, "dfa.json")
        with open(self.dfa_path, "w", encoding="utf-8") as fh:
            json.dump(DFA, fh)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "symdfa.cli", *args],
            capture_output=True, text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def test_minimize_and_verify_roundtrip(self):
        cert_path = os.path.join(self.tmp.name, "cert.json")
        proc = self.run_cli("minimize", self.dfa_path, "-o", cert_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(cert_path, encoding="utf-8") as fh:
            cert = json.load(fh)
        self.assertEqual(cert["quotient"]["num_states"], 4)

        proc = self.run_cli("verify", self.dfa_path, cert_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("certificate valid", proc.stdout)

    def test_verify_rejects_tampered(self):
        cert_path = os.path.join(self.tmp.name, "cert.json")
        self.run_cli("minimize", self.dfa_path, "-o", cert_path)
        with open(cert_path, encoding="utf-8") as fh:
            cert = json.load(fh)
        cert["block_map"]["0"] = "1"
        with open(cert_path, "w", encoding="utf-8") as fh:
            json.dump(cert, fh)
        proc = self.run_cli("verify", self.dfa_path, cert_path)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("INVALID", proc.stderr)

    def test_apply_incremental(self):
        changes_path = os.path.join(self.tmp.name, "changes.json")
        with open(changes_path, "w", encoding="utf-8") as fh:
            json.dump({"finals": [2]}, fh)
        out_path = os.path.join(self.tmp.name, "out.json")
        proc = self.run_cli("apply", self.dfa_path, changes_path, "-o", out_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out_path, encoding="utf-8") as fh:
            cert = json.load(fh)
        self.assertEqual(cert["quotient"]["finals"], [3])

    def test_apply_invalid_change_fails(self):
        changes_path = os.path.join(self.tmp.name, "changes.json")
        with open(changes_path, "w", encoding="utf-8") as fh:
            json.dump({"finals": [99]}, fh)
        proc = self.run_cli("apply", self.dfa_path, changes_path)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("previous partition restored", proc.stderr)


if __name__ == "__main__":
    unittest.main()
