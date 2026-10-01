import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run(
        [sys.executable, "-m", "prattx", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        env=env,
    )


class TestCli(unittest.TestCase):
    def test_expr_success(self):
        proc = run_cli("--expr", "1+2*3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        ast = json.loads(proc.stdout)
        self.assertEqual(ast["type"], "binary")
        self.assertEqual(ast["op"], "+")
        self.assertEqual(ast["right"]["op"], "*")
        self.assertEqual(proc.stderr, "")

    def test_file_success(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".expr", delete=False
        ) as fh:
            fh.write("a=b=c")
            path = fh.name
        try:
            proc = run_cli("--file", path)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        ast = json.loads(proc.stdout)
        self.assertEqual(ast["op"], "=")
        self.assertEqual(ast["right"]["op"], "=")

    def test_parse_error_exit_code_3_and_no_ast(self):
        proc = run_cli("--expr", "1+")
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout.strip(), "")  # no AST on stdout
        err = json.loads(proc.stderr)["error"]
        self.assertEqual(err["got"], "EOF")
        self.assertEqual(err["expected"], "expression")
        self.assertEqual(err["span"], [2, 2])

    def test_parse_error_stable(self):
        first = run_cli("--expr", "a(1,2][3]")
        second = run_cli("--expr", "a(1,2][3]")
        self.assertEqual(first.returncode, 3)
        self.assertEqual(first.stderr, second.stderr)
        err = json.loads(first.stderr)["error"]
        self.assertEqual(err["got"], "]")
        self.assertEqual(err["span"], [5, 6])

    def test_missing_file_exit_code_2(self):
        proc = run_cli("--file", "/nonexistent/definitely-not-here.expr")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()
