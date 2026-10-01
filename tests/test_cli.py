import json
import os
import subprocess
import sys
import tempfile
import unittest


def write_problem(tmpdir, problem):
    path = os.path.join(tmpdir, "problem.json")
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(problem, handle)
    return path


LAYERED = {
    "variables": {
        "a": [1, 2],
        "b": [2, 3],
        "c": [1, 2, 3],
        "d": [1, 2, 3],
        "e": [1, 2, 3],
    },
    "constraints": [
        {"var1": "a", "var2": "b", "allowed": [[1, 1], [2, 2], [3, 3]]},
        {"var1": "c", "var2": "d",
         "allowed": [[i, j] for i in (1, 2, 3) for j in (1, 2, 3) if i != j]},
        {"var1": "d", "var2": "e",
         "allowed": [[i, j] for i in (1, 2, 3) for j in (1, 2, 3) if i != j]},
    ],
}

CHAIN = {
    "variables": {"x": [1, 2], "y": [1, 2], "z": [1, 2]},
    "constraints": [
        {"var1": "x", "var2": "y", "allowed": [[1, 1], [2, 2]]},
        {"var1": "y", "var2": "z", "allowed": [[1, 1], [2, 2]]},
        {"var1": "x", "var2": "z", "allowed": [[1, 2], [2, 1]]},
    ],
}

UNSAT = {
    "variables": {"p": [1], "q": [2]},
    "constraints": [{"var1": "p", "var2": "q", "allowed": [[1, 1]]}],
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "csp_trail", *args],
        capture_output=True,
        text=True,
    )


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

    def test_run_no_assignments(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", "{}")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["current_level"], 0)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"]["a"], [2])
        self.assertEqual(out["domains"]["b"], [2])
        self.assertEqual(out["domains"]["c"], [1, 2, 3])

    def test_run_with_assignments(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path,
                       "--assign", '{"c": 1, "d": 2, "e": 1}')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["current_level"], 3)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["domains"]["c"], [1])
        self.assertEqual(out["domains"]["d"], [2])
        self.assertEqual(out["domains"]["e"], [1])

    def test_run_conflict_rolls_back(self):
        path = write_problem(self.tmpdir.name, CHAIN)
        proc = run_cli("run", "--input", path, "--assign", '{"x": 1}')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "conflict")
        # assignment and propagation undone
        self.assertEqual(out["current_level"], 0)
        self.assertEqual(out["domains"]["x"], [1, 2])
        self.assertEqual(out["domains"]["y"], [1, 2])
        self.assertEqual(out["domains"]["z"], [1, 2])

    def test_run_unsat(self):
        path = write_problem(self.tmpdir.name, UNSAT)
        proc = run_cli("run", "--input", path, "--assign", "{}")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["status"], "unsat")
        self.assertEqual(out["current_level"], 0)

    def test_run_with_backtrack_option(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path,
                       "--assign", '{"c": 1, "d": 2, "e": 1}',
                       "--backtrack", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertEqual(out["current_level"], 1)
        self.assertEqual(out["domains"]["c"], [1])
        self.assertEqual(out["domains"]["d"], [2, 3])
        self.assertEqual(out["domains"]["e"], [1, 2, 3])
        self.assertEqual(out["domains"]["a"], [2])

    def test_error_unknown_variable(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", '{"nope": 1}')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("unknown variable", proc.stderr)

    def test_error_value_not_in_domain(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", '{"c": 99}')
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("not in the domain", proc.stderr)

    def test_error_backtrack_negative(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", '{"c": 1}',
                       "--backtrack", "-1")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn(">= 0", proc.stderr)

    def test_error_backtrack_beyond_current(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", '{"c": 1}',
                       "--backtrack", "5")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("exceeds current level", proc.stderr)

    def test_error_missing_input_file(self):
        proc = run_cli("run", "--input",
                       os.path.join(self.tmpdir.name, "missing.json"),
                       "--assign", "{}")
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(proc.stderr.strip())

    def test_error_invalid_assign_json(self):
        path = write_problem(self.tmpdir.name, LAYERED)
        proc = run_cli("run", "--input", path, "--assign", "not-json")
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(proc.stderr.strip())


if __name__ == "__main__":
    unittest.main()
