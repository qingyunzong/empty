import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SCENARIO_ONE = {
    "variables": [
        {"name": "x", "domain": [1, 2]},
        {"name": "y", "domain": [1, 2]},
        {"name": "z", "domain": [1, 2]},
    ],
    "constraints": [
        {"type": "table", "vars": ["x", "z"], "allowed": [[1, 1], [2, 2]]},
        {"type": "table", "vars": ["y", "z"], "allowed": [[1, 2], [2, 2]]},
    ],
}


def run_cli(*argv):
    env = dict(os.environ)
    env["PYTHONPATH"] = ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "csp_restart", *argv],
        capture_output=True,
        text=True,
        cwd=ROOT,
        env=env,
    )


class CliTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def write_file(self, name, content):
        path = os.path.join(self._tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content)
        return path

    def write_problem(self, payload):
        return self.write_file("problem.json", json.dumps(payload))

    def test_run_success_outputs_required_fields(self):
        path = self.write_problem(SCENARIO_ONE)
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "2", "--total-budget", "100"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(
            set(output), {"status", "solution", "nogoods", "restart_count"}
        )
        self.assertEqual(output["status"], "sat")
        self.assertEqual(output["solution"], {"x": 2, "y": 1, "z": 2})
        self.assertEqual(output["restart_count"], 1)
        self.assertEqual(len(output["nogoods"]), 3)

    def test_run_timeout_status(self):
        path = self.write_problem(SCENARIO_ONE)
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "2", "--total-budget", "0"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        output = json.loads(proc.stdout)
        self.assertEqual(output["status"], "timeout")
        self.assertIsNone(output["solution"])
        self.assertEqual(output["restart_count"], 0)

    def test_negative_restart_threshold_fails(self):
        path = self.write_problem(SCENARIO_ONE)
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "-1", "--total-budget", "10"
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_negative_total_budget_fails(self):
        path = self.write_problem(SCENARIO_ONE)
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "1", "--total-budget", "-5"
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_malformed_json_fails(self):
        path = self.write_file("broken.json", "{not json")
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "1", "--total-budget", "10"
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_invalid_problem_fails(self):
        path = self.write_problem(
            {
                "variables": [{"name": "x", "domain": [1]}],
                "constraints": [{"type": "eq", "vars": ["x", "ghost"]}],
            }
        )
        proc = run_cli(
            "run", "--input", path, "--restart-threshold", "1", "--total-budget", "10"
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_missing_input_file_fails(self):
        proc = run_cli(
            "run",
            "--input",
            os.path.join(self._tmp.name, "does-not-exist.json"),
            "--restart-threshold",
            "1",
            "--total-budget",
            "10",
        )
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
