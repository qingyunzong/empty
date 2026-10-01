import subprocess
import sys
import unittest


def run_cli(stdin_text):
    return subprocess.run(
        [sys.executable, "-m", "sheetcalc"],
        input=stdin_text, capture_output=True, text=True,
    )


class TestCli(unittest.TestCase):
    def test_set_get_dump(self):
        proc = run_cli("set B1 2\nset A1 B1+1\nget A1\ndump\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertEqual(lines[0], "3")
        dump_names = [line.split(" ")[0] for line in lines[1:]]
        self.assertEqual(dump_names, ["A1", "B1"])  # lexicographic order

    def test_parse_error_exit_2(self):
        proc = run_cli("set A1 1+\n")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("error:", proc.stderr)

    def test_cycle_exit_3_and_atomic(self):
        proc = run_cli("set A1 B1\nset B1 A1\n")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("error:", proc.stderr)

    def test_undefined_reference_warning_on_stderr(self):
        proc = run_cli("set A1 Q7+1\nget A1\n")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("warning:", proc.stderr)
        self.assertIn("Q7", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "1")

    def test_div_zero_output(self):
        proc = run_cli("set A1 1/0\nget A1\n")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "E_DIV0")

    def test_del_command(self):
        proc = run_cli("set B1 5\nset A1 B1+1\ndel B1\nget A1\nget B1\n")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.splitlines(), ["1", "0"])


if __name__ == "__main__":
    unittest.main()
