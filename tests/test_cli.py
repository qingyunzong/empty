import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recompute.cli import main

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CliTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state.json")

    def run_cli(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(["--state", self.state, *args])
        return code, out.getvalue(), err.getvalue()

    def status_flags(self):
        code, out, _ = self.run_cli("status")
        self.assertEqual(code, 0)
        flags = {}
        for line in out.splitlines():
            parts = line.split()
            flags[parts[0]] = "dirty" in parts
        return flags


class FlowTests(CliTestBase):
    def test_full_flow_run_best_status(self):
        self.assertEqual(self.run_cli("set", "a", "2", "5")[0], 0)
        self.assertEqual(self.run_cli("set", "b", "3", "7", "a")[0], 0)
        self.assertEqual(self.run_cli("set", "c", "1", "4")[0], 0)
        self.assertEqual(
            self.status_flags(), {"a": True, "b": True, "c": True}
        )

        # dry run: optimal plan within 3 is {a, c} (value 9, cost 3)
        code, out, _ = self.run_cli("best", "3")
        self.assertEqual(code, 0)
        self.assertIn("selected: a c", out)
        self.assertIn("cost: 3", out)
        self.assertIn("value: 9", out)
        self.assertIn("clean_value: 9", out)
        # dry run must not change anything
        self.assertEqual(
            self.status_flags(), {"a": True, "b": True, "c": True}
        )

        # real run applies the same plan and persists it
        code, out, _ = self.run_cli("run", "3")
        self.assertEqual(code, 0)
        self.assertIn("selected: a c", out)
        self.assertEqual(
            self.status_flags(), {"a": False, "b": True, "c": False}
        )

        # only b is left dirty; it fits the next budget exactly
        code, out, _ = self.run_cli("run", "3")
        self.assertEqual(code, 0)
        self.assertIn("selected: b", out)
        self.assertIn("clean_value: 16", out)
        self.assertEqual(
            self.status_flags(), {"a": False, "b": False, "c": False}
        )

        # nothing dirty: empty plan
        code, out, _ = self.run_cli("run", "100")
        self.assertEqual(code, 0)
        self.assertIn("selected:\n", out)

    def test_upd_propagates_through_cli(self):
        self.run_cli("set", "a", "1", "1")
        self.run_cli("set", "b", "1", "1", "a")
        self.run_cli("set", "c", "1", "1", "b")
        self.run_cli("run", "10")
        self.assertEqual(
            self.status_flags(), {"a": False, "b": False, "c": False}
        )
        self.assertEqual(self.run_cli("upd", "a", "2")[0], 0)
        self.assertEqual(
            self.status_flags(), {"a": True, "b": True, "c": True}
        )
        code, out, _ = self.run_cli("best", "10")
        self.assertIn("selected: a b c", out)

    def test_budget_boundary_equal_cost(self):
        self.run_cli("set", "a", "5", "10")
        code, out, _ = self.run_cli("run", "5")
        self.assertEqual(code, 0)
        self.assertIn("selected: a", out)

    def test_budget_insufficient_selects_empty(self):
        self.run_cli("set", "a", "10", "1")
        code, out, _ = self.run_cli("run", "3")
        self.assertEqual(code, 0)
        self.assertIn("selected:\n", out)
        self.assertIn("cost: 0", out)
        self.assertEqual(self.status_flags(), {"a": True})


class ExitCodeTests(CliTestBase):
    def test_negative_cost_exit_2(self):
        code, _, err = self.run_cli("set", "a", "-1", "5")
        self.assertEqual(code, 2)
        self.assertIn("error:", err)

    def test_negative_budget_exit_2(self):
        self.run_cli("set", "a", "1", "1")
        code, _, _ = self.run_cli("run", "-3")
        self.assertEqual(code, 2)
        code, _, _ = self.run_cli("best", "-1")
        self.assertEqual(code, 2)

    def test_non_integer_arguments_exit_2(self):
        self.assertEqual(self.run_cli("set", "a", "x", "5")[0], 2)
        self.assertEqual(self.run_cli("set", "a", "1", "y")[0], 2)
        self.assertEqual(self.run_cli("run", "z")[0], 2)

    def test_cycle_exit_3(self):
        self.run_cli("set", "a", "1", "1")
        self.run_cli("set", "b", "1", "1", "a")
        code, _, err = self.run_cli("set", "a", "1", "1", "b")
        self.assertEqual(code, 3)
        self.assertIn("cycle", err)

    def test_self_cycle_exit_3(self):
        self.assertEqual(self.run_cli("set", "a", "1", "1", "a")[0], 3)

    def test_unknown_node_exit_4(self):
        self.assertEqual(self.run_cli("upd", "ghost", "1")[0], 4)
        self.assertEqual(self.run_cli("set", "b", "1", "1", "ghost")[0], 4)

    def test_usage_errors_exit_2(self):
        self.assertEqual(self.run_cli()[0], 2)
        self.assertEqual(self.run_cli("frobnicate")[0], 2)
        self.assertEqual(self.run_cli("set", "a", "1")[0], 2)
        self.assertEqual(self.run_cli("upd", "a")[0], 2)
        self.assertEqual(self.run_cli("run")[0], 2)
        self.assertEqual(self.run_cli("status", "extra")[0], 2)


class SubprocessTests(unittest.TestCase):
    def test_module_entrypoint_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "state.json")
            env = dict(os.environ, RECOMPUTE_STATE=state)
            base = [sys.executable, "-m", "recompute"]
            for args in (("set", "a", "2", "5"), ("set", "b", "1", "4")):
                proc = subprocess.run(
                    base + list(args), cwd=REPO_ROOT, env=env,
                    capture_output=True, text=True,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)
            proc = subprocess.run(
                base + ["run", "2"], cwd=REPO_ROOT, env=env,
                capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("selected: a", proc.stdout.splitlines())
            proc = subprocess.run(
                base + ["run", "-1"], cwd=REPO_ROOT, env=env,
                capture_output=True, text=True,
            )
            self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
