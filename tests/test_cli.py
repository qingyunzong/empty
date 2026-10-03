"""End-to-end tests for the JSON command line interface."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

from machines import adaptive_only_machine, resume_machine, simple_machine

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*argv):
    proc = subprocess.run(
        [sys.executable, "-m", "mealy.cli", *argv],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    return proc


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write_json(self, name, data):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        return path

    def machine_path(self, machine, name="machine.json"):
        return self.write_json(name, machine.to_dict())


class TestCli(CliCase):
    def test_pairs_command(self):
        path = self.machine_path(simple_machine())
        proc = run_cli("pairs", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertIn("pairs", out)
        self.assertIn("equivalent_classes", out)
        by_pair = {tuple(p["states"]): p for p in out["pairs"]}
        entry = by_pair[("s1", "s2")]
        self.assertTrue(entry["distinguishable"])
        self.assertEqual(entry["length"], 1)
        self.assertEqual(entry["witness"], ["b"])

    def test_tree_and_verify_roundtrip(self):
        machine = adaptive_only_machine()
        path = self.machine_path(machine)
        proc = run_cli("tree", path, "--set", "A1", "A2", "B1", "B2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "optimal")
        self.assertTrue(out["optimal"])
        self.assertEqual(out["depth"], 2)
        cert_path = self.write_json("cert.json", out)
        proc = run_cli("verify", path, cert_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        check = json.loads(proc.stdout)
        self.assertTrue(check["valid"], check["errors"])
        self.assertEqual(check["stats"]["leaves"], 4)

    def test_preset_command(self):
        path = self.machine_path(simple_machine())
        proc = run_cli("preset", path, "--max-len", "4")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["found"])
        self.assertEqual(out["length"], 2)
        path2 = self.machine_path(adaptive_only_machine(), "m2.json")
        proc = run_cli(
            "preset", path2, "--set", "A1", "A2", "B1", "B2", "--max-len", "3"
        )
        out = json.loads(proc.stdout)
        self.assertFalse(out["found"])

    def test_tree_partial_then_resume(self):
        path = self.machine_path(resume_machine())
        proc = run_cli("tree", path, "--budget", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        partial = json.loads(proc.stdout)
        self.assertEqual(partial["status"], "partial")
        self.assertFalse(partial["optimal"])
        self.assertIsNotNone(partial["resume_state"])
        state_path = self.write_json("state.json", partial["resume_state"])
        proc = run_cli("tree", path, "--budget", "100000", "--resume", state_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        resumed = json.loads(proc.stdout)
        self.assertEqual(resumed["status"], "optimal")
        self.assertEqual(resumed["depth"], 2)

    def test_infeasible_tree_reports_classes(self):
        from machines import equivalent_machine

        path = self.machine_path(equivalent_machine())
        proc = run_cli("tree", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "infeasible")
        self.assertIn(["E1", "E2"], out["equivalent_classes"])
        self.assertTrue(out["evidence"])

    def test_invalid_machine_rejected(self):
        path = self.write_json("bad.json", {"states": [], "inputs": ["a"]})
        proc = run_cli("pairs", path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", proc.stderr)

    def test_verify_rejects_tampered_certificate(self):
        path = self.machine_path(simple_machine())
        proc = run_cli("tree", path)
        out = json.loads(proc.stdout)
        out["tree"]["children"]["0"] = {"type": "leaf", "state": "s1"}
        cert_path = self.write_json("bad-cert.json", out)
        proc = run_cli("verify", path, cert_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        check = json.loads(proc.stdout)
        self.assertFalse(check["valid"])


if __name__ == "__main__":
    unittest.main()
