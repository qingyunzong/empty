"""End-to-end CLI tests via ``python -m tinyvm`` (acceptance D included)."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tinyvm.asm import assemble
from tinyvm.program import Program

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "tinyvm", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


class TestCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def bc(self, source):
        path = Path(self.tmp.name) / "prog.bc"
        path.write_bytes(assemble(source).serialize())
        return str(path)

    def test_normal_halt_prints_json_result(self):
        proc = run_cli(self.bc("""
            .consts 6 7
            CONST 0
            CONST 1
            MUL
            HALT
        """))
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), {"result": 42})
        self.assertEqual(proc.stderr, "")

    def test_trace_goes_to_stderr(self):
        proc = run_cli(self.bc("""
            .consts 2 3
            CONST 0
            CONST 1
            ADD
            HALT
        """), "--trace")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(json.loads(proc.stdout), {"result": 5})
        lines = proc.stderr.splitlines()
        self.assertEqual(len(lines), 4)
        self.assertEqual(lines[0], "step=0 pc=0 op=CONST arg=0 stack=[]")
        self.assertEqual(lines[-1], "step=3 pc=7 op=HALT stack=[5]")

    def test_bad_file_exits_6(self):
        path = Path(self.tmp.name) / "bad.bc"
        path.write_bytes(b"NOPE not a bytecode file")
        proc = run_cli(str(path))
        self.assertEqual(proc.returncode, 6)
        self.assertIn("tinyvm: error:", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_missing_file_exits_6(self):
        proc = run_cli(str(Path(self.tmp.name) / "nope.bc"))
        self.assertEqual(proc.returncode, 6)

    def test_mid_instruction_jump_exits_6(self):
        # Acceptance B through the CLI: JMP target 1 is inside the CONST.
        code = bytes([0x01, 0, 0, 0x20, 1, 0, 0x3F])  # CONST 0; JMP 1; HALT
        path = Path(self.tmp.name) / "midjump.bc"
        path.write_bytes(Program(consts=[9], nlocals=0, code=code).serialize())
        proc = run_cli(str(path))
        self.assertEqual(proc.returncode, 6)
        self.assertIn("boundary", proc.stderr)

    def test_div_by_zero_exit_code_and_trace_prefix(self):
        # Acceptance D, part 1: RuntimeFault -> exit 3, executed trace
        # prefix on stderr, nothing on stdout.
        proc = run_cli(self.bc("""
            .consts 1 0
            CONST 0
            CONST 1
            DIV
            HALT
        """), "--trace")
        self.assertEqual(proc.returncode, 3)
        self.assertEqual(proc.stdout, "")
        lines = proc.stderr.splitlines()
        self.assertEqual(
            lines[:3],
            [
                "step=0 pc=0 op=CONST arg=0 stack=[]",
                "step=1 pc=3 op=CONST arg=1 stack=[1]",
                "step=2 pc=6 op=DIV stack=[1, 0]",
            ],
        )
        self.assertIn("RuntimeFault", lines[-1])
        self.assertIn("pc=6 step=2", lines[-1])

    def test_step_limit_exit_code_differs(self):
        # Acceptance D, part 2: StepLimit -> exit 9 (distinct from 3).
        proc = run_cli(self.bc("main: JMP main"), "--step-limit", "50000")
        self.assertEqual(proc.returncode, 9)
        self.assertIn("StepLimit", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_stack_overflow_exit_7(self):
        lines = [".consts 0"] + ["CONST 0"] * 300 + ["HALT"]
        proc = run_cli(self.bc("\n".join(lines)))
        self.assertEqual(proc.returncode, 7)
        self.assertIn("StackOverflow", proc.stderr)

    def test_frame_overflow_exit_8(self):
        proc = run_cli(self.bc("""
            main:
              CALL f
              HALT
            f:
              CALL f
              RET
        """))
        self.assertEqual(proc.returncode, 8)
        self.assertIn("FrameOverflow", proc.stderr)

    def test_empty_halt_exit_5(self):
        proc = run_cli(self.bc("HALT"))
        self.assertEqual(proc.returncode, 5)
        self.assertIn("EmptyHalt", proc.stderr)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
