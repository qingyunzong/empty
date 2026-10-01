import json
import subprocess
import sys
import unittest


def run_cli(request):
    proc = subprocess.run(
        [sys.executable, "-m", "fdsolver"],
        input=json.dumps(request), capture_output=True, text=True)
    return proc


HALL_REQUEST = {
    "command": "propagate",
    "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
    "constraints": [{"type": "allDifferent", "vars": ["a", "b", "c"]}],
}

UNSAT_REQUEST = {
    "command": "solve",
    "variables": {"x": [1, 2], "y": [1, 2], "z": [1, 2]},
    "constraints": [
        {"type": "table", "vars": ["x", "y"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "vars": ["x", "z"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "vars": ["y", "z"], "tuples": [[1, 2], [2, 1]]},
    ],
}


class TestCli(unittest.TestCase):
    def test_propagate_hall(self):
        proc = run_cli(HALL_REQUEST)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"]["c"], [3])

    def test_solve_unsat_certificate_roundtrip(self):
        proc = run_cli(UNSAT_REQUEST)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unsat")
        verify_req = dict(UNSAT_REQUEST)
        verify_req["command"] = "verify"
        verify_req["certificate"] = out["certificate"]
        proc2 = run_cli(verify_req)
        self.assertEqual(json.loads(proc2.stdout)["valid"], True)
        # tampered certificate rejected
        verify_req["certificate"] = "conflict"
        proc3 = run_cli(verify_req)
        self.assertEqual(json.loads(proc3.stdout)["valid"], False)

    def test_solve_sat(self):
        req = {
            "command": "solve",
            "variables": {"a": [1, 2], "b": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "b"]}],
        }
        out = json.loads(run_cli(req).stdout)
        self.assertEqual(out["status"], "sat")
        self.assertEqual(sorted(out["witness"].values()), [1, 2])

    def test_budget_exhaustion_unknown(self):
        req = dict(UNSAT_REQUEST)
        req["budget"] = 0
        out = json.loads(run_cli(req).stdout)
        self.assertEqual(out["status"], "unknown")

    def test_deterministic_output(self):
        out1 = run_cli(UNSAT_REQUEST).stdout
        out2 = run_cli(UNSAT_REQUEST).stdout
        self.assertEqual(out1, out2)
        # keys are sorted at every level
        self.assertEqual(out1, json.dumps(json.loads(out1),
                                          sort_keys=True, indent=2) + "\n")

    def test_bad_reference_atomic_error(self):
        req = {
            "command": "propagate",
            "variables": {"a": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "ghost"]}],
        }
        proc = run_cli(req)
        self.assertEqual(proc.returncode, 1)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "error")
        self.assertIn("ghost", out["error"])

    def test_duplicate_variable_in_scope_error(self):
        req = {
            "command": "propagate",
            "variables": {"a": [1, 2]},
            "constraints": [{"type": "allDifferent", "vars": ["a", "a"]}],
        }
        out = json.loads(run_cli(req).stdout)
        self.assertEqual(out["status"], "error")

    def test_duplicate_json_key_error(self):
        proc = subprocess.run(
            [sys.executable, "-m", "fdsolver"],
            input='{"command": "propagate", "command": "solve"}',
            capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(json.loads(proc.stdout)["status"], "error")


if __name__ == "__main__":
    unittest.main()
