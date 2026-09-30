import json
import os
import subprocess
import sys
import tempfile
import unittest

from fixtures import equivalent_machine, no_preset_machine, three_state_machine

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "mealy_dist.cli", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write_machine(self, machine, name="machine.json"):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(machine.to_json())
        return path

    def test_pairs_command(self):
        path = self.write_machine(three_state_machine())
        result = run_cli("pairs", path)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["indistinguishable"], [])
        self.assertEqual(data["distinguishable"]["q0|q1"], ["b"])

    def test_tree_command_and_verify_round_trip(self):
        machine = no_preset_machine()
        machine_path = self.write_machine(machine)
        result = run_cli("tree", machine_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["status"], "optimal")
        self.assertTrue(data["optimal"])
        self.assertEqual(data["height"], 4)
        self.assertLessEqual(data["lower_bound"], 4)

        cert_path = os.path.join(self.tmp.name, "cert.json")
        with open(cert_path, "w", encoding="utf-8") as handle:
            json.dump(data["tree"], handle)
        verify = run_cli("verify", machine_path, cert_path)
        self.assertEqual(verify.returncode, 0, verify.stderr)
        report = json.loads(verify.stdout)
        self.assertTrue(report["valid"], report["errors"])

    def test_tree_command_impossible_machine(self):
        path = self.write_machine(equivalent_machine())
        result = run_cli("tree", path)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["status"], "impossible")
        self.assertFalse(data["possible"])
        self.assertIn(["e0", "e1"], data["indistinguishable"]["classes"])
        self.assertTrue(data["indistinguishable"]["evidence"])

    def test_tree_command_budget_exhaustion(self):
        path = self.write_machine(no_preset_machine())
        result = run_cli("tree", path, "--budget", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["status"], "partial")
        self.assertFalse(data["optimal"])
        self.assertGreaterEqual(data["lower_bound"], 1)

    def test_brute_command(self):
        path = self.write_machine(three_state_machine())
        result = run_cli("brute", path)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertTrue(data["consistent"])
        self.assertEqual(data["adaptive_optimal"], 2)
        self.assertEqual(data["preset_optimal"], 2)

    def test_verify_rejects_tampered_certificate(self):
        machine_path = self.write_machine(three_state_machine())
        result = run_cli("tree", machine_path)
        tree = json.loads(result.stdout)["tree"]
        tree["type"] = "leaf"
        tree["state"] = "q0"
        cert_path = os.path.join(self.tmp.name, "bad.json")
        with open(cert_path, "w", encoding="utf-8") as handle:
            json.dump(tree, handle)
        verify = run_cli("verify", machine_path, cert_path)
        self.assertEqual(verify.returncode, 0)
        self.assertFalse(json.loads(verify.stdout)["valid"])

    def test_invalid_machine_file_reports_error(self):
        bad_path = os.path.join(self.tmp.name, "bad.json")
        with open(bad_path, "w", encoding="utf-8") as handle:
            handle.write('{"states": [], "inputs": [], "outputs": []}')
        result = run_cli("pairs", bad_path)
        self.assertEqual(result.returncode, 2)
        self.assertIn("error", json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()
