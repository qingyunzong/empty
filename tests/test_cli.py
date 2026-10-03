import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MACHINE_A = {
    "states": ["q0", "q1"],
    "initial": "q0",
    "accepting": ["q1"],
    "transitions": {"q0": [[0, 10, "q1"]], "q1": [[0, 65535, "q1"]]},
}
MACHINE_B = {
    "states": ["r0", "r1"],
    "initial": "r0",
    "accepting": ["r1"],
    "transitions": {"r0": [[0, 5, "r1"], [6, 10, "r1"]],
                    "r1": [[0, 65535, "r1"]]},
}
MACHINE_C = {
    "states": ["s0"],
    "initial": "s0",
    "accepting": [],
    "transitions": {},
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "symdfa", *args],
        cwd=REPO_ROOT, capture_output=True, text=True)


class CliCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def write(self, name, data):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        return path

    def test_check_equivalent_and_verify(self):
        a = self.write("a.json", MACHINE_A)
        b = self.write("b.json", MACHINE_B)
        proc = run_cli("check", "--a", a, "--b", b)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "equivalent")
        proof = self.write("proof.json", result["proof"])
        proc = run_cli("verify", "--a", a, "--b", b, "--certificate", proof)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_check_different_and_verify_counterexample(self):
        a = self.write("a.json", MACHINE_A)
        c = self.write("c.json", MACHINE_C)
        proc = run_cli("check", "--a", a, "--b", c)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "different")
        self.assertEqual(result["counterexample"]["word"], [0])
        cert = self.write("cert.json", result["counterexample"])
        proc = run_cli("verify", "--a", a, "--b", c, "--certificate", cert)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_budget_resume_via_cli(self):
        a = self.write("a.json", MACHINE_A)
        b = self.write("b.json", MACHINE_B)
        proc = run_cli("check", "--a", a, "--b", b, "--budget", "1")
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "unknown")
        frontier = self.write("frontier.json", result["frontier"])
        proc = run_cli("check", "--a", a, "--b", b, "--resume", frontier)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "equivalent")

    def test_update_add_and_atomic_reject(self):
        a = self.write("a.json", MACHINE_A)
        out = os.path.join(self.tmp.name, "a2.json")
        proc = run_cli("update", "--machine", a, "--state", "q0",
                       "--lo", "20", "--hi", "30", "--target", "q0",
                       "--out", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(out) as fh:
            updated = json.load(fh)
        self.assertEqual(updated["version"], 1)
        self.assertEqual(updated["transitions"]["q0"],
                         [[0, 10, "q1"], [20, 30, "q0"]])
        # Overlapping update is rejected and no output file is written.
        out2 = os.path.join(self.tmp.name, "a3.json")
        proc = run_cli("update", "--machine", a, "--state", "q0",
                       "--lo", "5", "--hi", "40", "--target", "q0",
                       "--out", out2)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("overlap", json.loads(proc.stdout)["error"])
        self.assertFalse(os.path.exists(out2))

    def test_update_replace_and_reuse_old_proof(self):
        a = self.write("a.json", MACHINE_A)
        b = self.write("b.json", MACHINE_B)
        proc = run_cli("check", "--a", a, "--b", b)
        proof = self.write("proof.json", json.loads(proc.stdout)["proof"])
        a2 = os.path.join(self.tmp.name, "a2.json")
        proc = run_cli("update", "--machine", a, "--state", "q0",
                       "--replace", "0", "10",
                       "--lo", "0", "--hi", "10", "--target", "q1",
                       "--out", a2)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        # Old proof no longer verifies against the new version.
        proc = run_cli("verify", "--a", a2, "--b", b, "--certificate", proof)
        self.assertEqual(proc.returncode, 1)
        self.assertFalse(json.loads(proc.stdout)["valid"])
        # Re-check with reuse of the still-valid entries.
        proc = run_cli("check", "--a", a2, "--b", b, "--reuse", proof)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "equivalent")
        self.assertGreater(result["stats"]["reused_edges"], 0)


if __name__ == "__main__":
    unittest.main()
