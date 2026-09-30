import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SAT_INST = {
    "n_tasks": 3,
    "durations": [2, 2, 1],
    "constraints": [{"u": 0, "v": 2, "c": 6}],
    "disjuncts": [[0, 1], [1, 2], [0, 2]],
}

UNSAT_INST = {
    "n_tasks": 2,
    "durations": [2, 3],
    "constraints": [{"u": 0, "v": 1, "c": 0}, {"u": 1, "v": 0, "c": 0}],
    "disjuncts": [[0, 1]],
}


def run_cli(*args):
    return subprocess.run([sys.executable, "-m", "schedsolve", *args],
                          capture_output=True, text=True, cwd=ROOT)


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _write(self, name, obj):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return path

    def test_solve_sat_and_check(self):
        inst = self._write("sat.json", SAT_INST)
        proc = run_cli("solve", inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "sat")
        self.assertEqual(set(result["schedule"]), {"0", "1", "2"})
        self.assertTrue(all(isinstance(v, int)
                            for v in result["schedule"].values()))
        res = self._write("result.json", result)
        proc = run_cli("check", inst, res)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_solve_unsat_and_check(self):
        inst = self._write("unsat.json", UNSAT_INST)
        proc = run_cli("solve", inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "unsat")
        self.assertIn("conflict_tree", result)
        res = self._write("result.json", result)
        proc = run_cli("check", inst, res)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_check_rejects_tampered_evidence(self):
        inst = self._write("sat.json", SAT_INST)
        proc = run_cli("solve", inst)
        result = json.loads(proc.stdout)
        result["schedule"]["1"] = result["schedule"]["0"]  # force overlap
        res = self._write("tampered.json", result)
        proc = run_cli("check", inst, res)
        self.assertEqual(proc.returncode, 1)
        payload = json.loads(proc.stdout)
        self.assertFalse(payload["valid"])
        self.assertIsInstance(payload["reason"], str)

    def test_unknown_then_resume_via_frontier(self):
        inst = self._write("sat.json", SAT_INST)
        proc = run_cli("solve", inst, "--branch-budget", "0")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        first = json.loads(proc.stdout)
        self.assertEqual(first["status"], "unknown")
        self.assertIn("frontier", first)
        self.assertIn("candidate", first)
        # check the unknown evidence too
        res = self._write("unknown.json", first)
        proc = run_cli("check", inst, res)
        self.assertEqual(proc.returncode, 0)
        # resume from the saved frontier
        frontier = self._write("frontier.json", first["frontier"])
        proc = run_cli("solve", inst, "--frontier", frontier)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        final = json.loads(proc.stdout)
        self.assertEqual(final["status"], "sat")

    def test_relax_budget_unknown(self):
        inst = self._write("unsat.json", UNSAT_INST)
        proc = run_cli("solve", inst, "--relax-budget", "1")
        self.assertEqual(json.loads(proc.stdout)["status"], "unknown")
        proc = run_cli("solve", inst, "--relax-budget", "100")
        self.assertEqual(json.loads(proc.stdout)["status"], "unsat")

    def test_brute_command(self):
        inst = self._write("unsat.json", UNSAT_INST)
        proc = run_cli("brute", inst)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], "unsat")
        inst = self._write("sat.json", SAT_INST)
        proc = run_cli("brute", inst, "--horizon", "12")
        self.assertEqual(json.loads(proc.stdout)["status"], "sat")

    def test_invalid_input_exit_code(self):
        bad = self._write("bad.json", {"n_tasks": 2, "durations": [1, 0]})
        proc = run_cli("solve", bad)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error", json.loads(proc.stderr))
        missing = os.path.join(self.tmp.name, "missing.json")
        proc = run_cli("solve", missing)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
