"""CLI tests: real subprocess runs of `python -m incsp`."""

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(stdin_text):
    return subprocess.run(
        [sys.executable, "-m", "incsp"],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class TestCLI(unittest.TestCase):
    def test_basic_session(self):
        r = run_cli("src s\nedge s a 2\nedge a t 3\ndist t\npath t\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["5", "s a t"])

    def test_unreachable_dist_and_path_exit_0(self):
        r = run_cli("src s\nedge s a 1\ndist zzz\npath zzz\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.split("\n")
        self.assertEqual(lines[0], "INF")
        self.assertEqual(lines[1], "")  # empty path line

    def test_negative_weight_exit_2(self):
        r = run_cli("src s\nedge s a -1\n")
        self.assertEqual(r.returncode, 2)
        self.assertIn("error", r.stderr)

    def test_weight_above_max_exit_2(self):
        r = run_cli("edge s a 1000001\n")
        self.assertEqual(r.returncode, 2)

    def test_non_integer_weight_exit_2(self):
        r = run_cli("edge s a 1.5\n")
        self.assertEqual(r.returncode, 2)

    def test_invalid_command_exit_2(self):
        r = run_cli("bogus s a\n")
        self.assertEqual(r.returncode, 2)

    def test_unknown_nodes_and_self_loop_ok(self):
        r = run_cli("edge x y 5\nedge x x 3\nsrc x\ndist y\npath y\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["5", "x y"])

    def test_recomputed_command(self):
        r = run_cli(
            "src s\nedge s a 1\nedge a b 1\nedge b c 1\n"
            "rm a b\nrecomputed\ndist c\n"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["2", "INF"])

    def test_incremental_not_full_recompute(self):
        # 100-node chain; adding one shortcut must not recompute everything.
        lines = ["src n0"]
        for i in range(100):
            lines.append(f"edge n{i} n{i+1} 1")
        lines.append("edge n0 n100 5")
        lines.append("recomputed")
        lines.append("dist n100")
        r = run_cli("\n".join(lines) + "\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        recomputed, dist = r.stdout.splitlines()
        self.assertEqual(dist, "5")
        self.assertLessEqual(int(recomputed), 50)  # far below full graph size


if __name__ == "__main__":
    unittest.main()
