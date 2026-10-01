"""End-to-end CLI tests (acceptance item D lives here)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

from tinyvm.asm import assemble
from tinyvm.loader import dump_program

from helpers import factorial_program

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(data, *args):
    with tempfile.NamedTemporaryFile(suffix=".bc", delete=False) as tmp:
        tmp.write(data)
        path = tmp.name
    try:
        return subprocess.run(
            [sys.executable, "-m", "tinyvm", path, *args],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
    finally:
        os.unlink(path)


def program(consts, items):
    return dump_program(consts, assemble(items))


class CliTests(unittest.TestCase):
    def test_success_prints_stack_top_json(self):
        proc = run_cli(program([40, 2], [("CONST", 0), ("CONST", 1), ("ADD",), ("HALT",)]))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), 42)

    def test_bad_file_exits_6(self):
        proc = run_cli(b"\x00\x01\x02garbage")
        self.assertEqual(proc.returncode, 6)
        self.assertIn("VMError", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_missing_file_exits_6(self):
        proc = subprocess.run(
            [sys.executable, "-m", "tinyvm", "/nonexistent/prog.bc"],
            capture_output=True,
            text=True,
            cwd=ROOT,
        )
        self.assertEqual(proc.returncode, 6)

    def test_div_by_zero_exit_code_and_trace_prefix(self):
        data = program([1, 0], [("CONST", 0), ("CONST", 1), ("DIV",), ("HALT",)])
        proc = run_cli(data, "--trace")
        self.assertEqual(proc.returncode, 5)
        self.assertEqual(proc.stdout, "")  # no result on stdout
        self.assertIn("RuntimeFault", proc.stderr)
        self.assertIn("DIV", proc.stderr)  # executed trace prefix present

    def test_step_limit_exit_code(self):
        proc = run_cli(program([], ["loop", ("JMP", "loop")]))
        self.assertEqual(proc.returncode, 2)
        self.assertIn("StepLimit", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_div_zero_and_step_limit_codes_differ(self):
        div = run_cli(program([1, 0], [("CONST", 0), ("CONST", 1), ("DIV",), ("HALT",)]))
        step = run_cli(program([], ["loop", ("JMP", "loop")]))
        self.assertNotEqual(div.returncode, step.returncode)
        self.assertEqual(div.returncode, 5)
        self.assertEqual(step.returncode, 2)

    def test_frame_overflow_exit_code(self):
        proc = run_cli(factorial_program(100))
        self.assertEqual(proc.returncode, 3)
        self.assertIn("FrameOverflow", proc.stderr)

    def test_stack_overflow_exit_code(self):
        items = [("CONST", 0)] * 257 + [("HALT",)]
        proc = run_cli(program([1], items))
        self.assertEqual(proc.returncode, 4)
        self.assertIn("StackOverflow", proc.stderr)

    def test_empty_halt_exit_code(self):
        proc = run_cli(program([], [("HALT",)]))
        self.assertEqual(proc.returncode, 7)
        self.assertIn("EmptyHalt", proc.stderr)

    def test_factorial_via_cli(self):
        proc = run_cli(factorial_program(5))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), 120)


if __name__ == "__main__":
    unittest.main()
