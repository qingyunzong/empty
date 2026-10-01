import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(script: str):
    return subprocess.run(
        [sys.executable, "-m", "incsp"],
        input=script,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class CliTest(unittest.TestCase):
    def test_basic_queries(self):
        r = run_cli(
            "src s\n"
            "edge s a 1\n"
            "edge a t 2\n"
            "edge s t 9\n"
            "dist t\n"
            "path t\n"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["3", "s a t"])

    def test_unreachable_is_inf_and_empty_path_exit0(self):
        r = run_cli("src s\nedge s a 1\ndist z\npath z\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.split("\n")
        self.assertEqual(lines[0], "INF")
        self.assertEqual(lines[1], "")  # empty path line

    def test_negative_weight_exits_2(self):
        r = run_cli("src s\nedge s a -1\n")
        self.assertEqual(r.returncode, 2)
        self.assertIn("negative", r.stderr)

    def test_malformed_command_exits_2(self):
        r = run_cli("src s\nbogus x\n")
        self.assertEqual(r.returncode, 2)

    def test_duplicate_edge_min_and_single_removal(self):
        r = run_cli(
            "src s\n"
            "edge s a 5\n"
            "edge s a 3\n"
            "dist a\n"
            "rm s a\n"
            "dist a\n"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["3", "INF"])

    def test_src_switch_clears_cache(self):
        r = run_cli(
            "src s\n"
            "edge s a 1\n"
            "dist a\n"
            "src x\n"
            "dist a\n"
            "edge x a 4\n"
            "dist a\n"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["1", "INF", "4"])

    def test_unknown_nodes_auto_created_and_self_loop(self):
        r = run_cli("src s\nedge s s 0\nedge s q 2\ndist q\npath q\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["2", "s q"])

    def test_remove_bridge_then_recomputed(self):
        r = run_cli(
            "src s\n"
            "edge s a 2\n"
            "edge a b 3\n"
            "dist b\n"
            "rm a b\n"
            "dist b\n"
            "recomputed\n"
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines(), ["5", "INF", "1"])

    def test_commands_from_file(self):
        path = os.path.join(ROOT, "tests", "_tmp_commands.txt")
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("src s\nedge s t 7\ndist t\n")
            r = subprocess.run(
                [sys.executable, "-m", "incsp", path],
                capture_output=True, text=True, cwd=ROOT,
            )
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.splitlines(), ["7"])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
