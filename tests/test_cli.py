"""End-to-end CLI tests: python -m prattx --expr/--file."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "prattx", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class CliTest(unittest.TestCase):
    def test_expr_success(self):
        proc = run_cli("--expr", "1+2*3")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stderr, "")
        ast = json.loads(proc.stdout)
        self.assertEqual(ast["op"], "+")
        self.assertEqual(ast["right"]["op"], "*")
        for key in ("op", "lbp", "rbp", "span"):
            self.assertIn(key, ast)

    def test_expr_error_exit_code_3_and_no_ast(self):
        proc = run_cli("--expr", "1+")
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, "")  # no AST on stdout
        err = json.loads(proc.stderr)["error"]
        self.assertEqual(err["got"], "<eof>")
        self.assertEqual(err["expected"], "expression")
        self.assertEqual(err["span"], [2, 2])

    def test_file_input(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".expr", delete=False
        ) as handle:
            handle.write("a?b:c")
            path = handle.name
        try:
            proc = run_cli("--file", path)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout)["op"], "?:")

    def test_file_error_exit_code_3(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".expr", delete=False
        ) as handle:
            handle.write("a(1,2][3]")
            path = handle.name
        try:
            proc = run_cli("--file", path)
        finally:
            os.unlink(path)
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, "")
        err = json.loads(proc.stderr)["error"]
        self.assertEqual(err["got"], "]")
        self.assertEqual(err["expected"], ")")

    def test_missing_file_exit_code_2(self):
        proc = run_cli("--file", "no/such/file.expr")
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")

    def test_requires_exactly_one_source(self):
        self.assertEqual(run_cli().returncode, 2)
        self.assertEqual(run_cli("--expr", "1", "--file", "x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
