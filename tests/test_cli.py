import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DFA = {
    "alphabet_size": 2,
    "start": 0,
    "finals": [3],
    "transitions": {
        "0": [[0, 0, 1], [1, 1, 0]],
        "1": [[0, 0, 2], [1, 1, 1]],
        "2": [[0, 0, 3], [1, 1, 2]],
        "3": [[0, 0, 3], [1, 1, 3]],
        "4": [[0, 1, 4]],
    },
}

OVERLAPPING = {
    "alphabet_size": 2,
    "start": 0,
    "finals": [],
    "transitions": {"0": [[0, 1, 0], [1, 1, 0]]},
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "symdfa", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dfa_path = Path(self.tmp.name) / "dfa.json"
        self.dfa_path.write_text(json.dumps(DFA))

    def tearDown(self):
        self.tmp.cleanup()

    def test_minimize_and_verify_roundtrip(self):
        proc = run_cli("minimize", str(self.dfa_path))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        cert = json.loads(proc.stdout)
        # Unreachable state 4 is trimmed; chain states stay separate.
        self.assertIsNone(cert["state_to_block"]["4"])
        self.assertEqual(len(cert["blocks"]), 4)
        cert_path = Path(self.tmp.name) / "cert.json"
        cert_path.write_text(proc.stdout)
        proc = run_cli("verify", str(self.dfa_path), str(cert_path))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_verify_rejects_tampered_cert(self):
        proc = run_cli("minimize", str(self.dfa_path))
        cert = json.loads(proc.stdout)
        cert["state_to_block"]["1"] = cert["state_to_block"]["0"]
        cert_path = Path(self.tmp.name) / "bad.json"
        cert_path.write_text(json.dumps(cert))
        proc = run_cli("verify", str(self.dfa_path), str(cert_path))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("invalid", proc.stderr)

    def test_update_command(self):
        updates = {"finals": {"3": False}, "transitions": {}}
        updates_path = Path(self.tmp.name) / "updates.json"
        updates_path.write_text(json.dumps(updates))
        proc = run_cli("update", str(self.dfa_path), str(updates_path))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        # No reachable finals left: everything merges into one block.
        self.assertEqual(len(result["blocks"]), 1)

    def test_baseline_command(self):
        proc = run_cli("baseline", str(self.dfa_path))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["match"])

    def test_overlapping_intervals_rejected(self):
        bad_path = Path(self.tmp.name) / "bad_dfa.json"
        bad_path.write_text(json.dumps(OVERLAPPING))
        proc = run_cli("minimize", str(bad_path))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("overlap", proc.stderr)


if __name__ == "__main__":
    unittest.main()
