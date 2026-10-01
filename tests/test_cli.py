import io
import subprocess
import sys
import unittest

from deptx.cli import run


def run_script(script: str):
    out, err = io.StringIO(), io.StringIO()
    code = run(script.splitlines(), out, err)
    return code, out.getvalue(), err.getvalue()


class TestCliInProcess(unittest.TestCase):
    def test_basic_flow(self):
        code, out, _ = run_script(
            "begin\nset k v\nget k\ncommit\nget k\n"
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.splitlines(), ["v", "v"])

    def test_get_missing_key_prints_none(self):
        code, out, _ = run_script("get missing\n")
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), "None")

    def test_cycle_exit_3_and_session_continues(self):
        code, out, err = run_script(
            "begin\n"
            "set k v\n"
            "depend a b\n"
            "depend b a\n"   # cycle -> exit 3, layer must survive
            "get k\n"
            "depend b c\n"   # still valid: non-cyclic edge accepted
            "commit\n"
            "get k\n"
        )
        self.assertEqual(code, 3)
        self.assertEqual(out.splitlines(), ["v", "v"])
        self.assertIn("cycle", err)

    def test_no_transaction_exit_11(self):
        code, _, err = run_script("set k v\n")
        self.assertEqual(code, 11)
        self.assertIn("no active transaction", err)

    def test_unknown_savepoint_exit_10(self):
        code, _, _ = run_script("begin\nundo nope\n")
        self.assertEqual(code, 10)

    def test_first_error_code_wins(self):
        code, _, _ = run_script("undo s\nbegin\nundo s\n")  # 11 then 10
        self.assertEqual(code, 11)

    def test_usage_error_exit_2(self):
        code, _, _ = run_script("bogus-command\n")
        self.assertEqual(code, 2)


class TestCliSubprocess(unittest.TestCase):
    def run_module(self, script: str):
        return subprocess.run(
            [sys.executable, "-m", "deptx"],
            input=script,
            capture_output=True,
            text=True,
        )

    def test_module_cycle_exit_code(self):
        proc = self.run_module("begin\ndepend a b\ndepend b a\nget a\ncommit\n")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("error", proc.stderr)

    def test_module_no_transaction_exit_code(self):
        proc = self.run_module("commit\n")
        self.assertEqual(proc.returncode, 11)

    def test_module_unknown_savepoint_exit_code(self):
        proc = self.run_module("begin\nundo ghost\n")
        self.assertEqual(proc.returncode, 10)

    def test_module_clean_run_exit_zero(self):
        proc = self.run_module("begin\nset x 1\ncommit\nget x\n")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "1")


if __name__ == "__main__":
    unittest.main()
