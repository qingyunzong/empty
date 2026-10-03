import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(stdin_text):
    return subprocess.run(
        [sys.executable, "-m", "recalc"],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class CliFlowTest(unittest.TestCase):
    def test_basic_script(self):
        script = "\n".join(
            [
                "# sample pipeline",
                "set a 2 5",
                "set b 3 4 a",
                "set c 1 10 b",
                "best 5",
                "run 5",
                "status",
                "run 1",
                "status",
                "",
            ]
        )
        proc = run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines[0], "selected: a,b value: 9 cost: 5")
        self.assertEqual(lines[1], "selected: a,b value: 9 cost: 5")
        self.assertEqual(lines[2], "dirty: c")
        self.assertEqual(lines[3], "selected: c value: 10 cost: 1")
        self.assertEqual(lines[4], "dirty: -")

    def test_upd_propagates_and_best_does_not_mutate(self):
        script = "\n".join(
            [
                "set a 1 1",
                "set b 1 1 a",
                "run 10",
                "upd a 2",
                "status",
                "best 2",
                "status",
            ]
        )
        proc = run_cli(script)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines[0], "selected: a,b value: 2 cost: 2")
        self.assertEqual(lines[1], "dirty: a,b")
        self.assertEqual(lines[2], "selected: a value: 1 cost: 2")
        self.assertEqual(lines[3], "dirty: a,b")

    def test_empty_selection_when_budget_too_small(self):
        proc = run_cli("set a 5 10\nrun 4\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("selected: - value: 0 cost: 0", proc.stdout)


class CliExitCodeTest(unittest.TestCase):
    def test_negative_budget_exits_2(self):
        proc = run_cli("set a 1 1\nrun -1\n")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("negative budget", proc.stderr)

    def test_negative_cost_exits_2(self):
        proc = run_cli("set a -1 5\n")
        self.assertEqual(proc.returncode, 2)
        proc = run_cli("set a 1 5\nupd a -2\n")
        self.assertEqual(proc.returncode, 2)

    def test_cycle_exits_3(self):
        proc = run_cli("set a 1 1\nset b 1 1 a\nset a 1 1 b\n")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("cycle", proc.stderr)

    def test_unknown_node_exits_4(self):
        proc = run_cli("upd ghost 1\n")
        self.assertEqual(proc.returncode, 4)
        proc = run_cli("set a 1 1 ghost\n")
        self.assertEqual(proc.returncode, 4)

    def test_unknown_command_exits_1(self):
        proc = run_cli("frobnicate a\n")
        self.assertEqual(proc.returncode, 1)


if __name__ == "__main__":
    unittest.main()
