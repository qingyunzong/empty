"""Runtime semantics and resource-limit tests (acceptance C included)."""

import io
import unittest

from tinyvm.asm import assemble
from tinyvm.errors import (
    EmptyHalt,
    FrameOverflow,
    RuntimeFault,
    StackOverflow,
    StepLimit,
)
from tinyvm.program import loads
from tinyvm.vm import VM


def run(source, **vm_kwargs):
    prog = loads(assemble(source).serialize())
    machine = VM(prog, **vm_kwargs)
    result = machine.run()
    return result, machine


FACTORIAL = """
.consts 1 5
.locals 1
main:
  CONST 1      # push 5
  CALL fact
  HALT
fact:
  STORE 0      # n = argument
  LOAD 0
  JZ base
  LOAD 0
  LOAD 0
  CONST 0      # push 1
  SUB
  CALL fact
  MUL
  RET
base:
  CONST 0
  RET
"""

INFINITE_RECURSION = """
main:
  CALL f
  HALT
f:
  CALL f
  RET
"""


class TestArithmetic(unittest.TestCase):
    def test_add_sub_mul(self):
        result, _ = run("""
            .consts 10 3 4
            CONST 0
            CONST 1
            SUB          # 10 - 3 = 7
            CONST 2
            MUL          # 7 * 4 = 28
            CONST 1
            ADD          # 28 + 3 = 31
            HALT
        """)
        self.assertEqual(result, 31)

    def test_div_mod_floor_semantics(self):
        result, _ = run("""
            .consts -7 2
            CONST 0
            CONST 1
            DIV          # -7 // 2 = -4 (floor)
            HALT
        """)
        self.assertEqual(result, -4)
        result, _ = run("""
            .consts -7 2
            CONST 0
            CONST 1
            MOD          # -7 % 2 = 1
            HALT
        """)
        self.assertEqual(result, 1)

    def test_locals_are_per_frame(self):
        result, _ = run(FACTORIAL)
        self.assertEqual(result, 120)


class TestFaults(unittest.TestCase):
    def test_div_by_zero(self):
        with self.assertRaises(RuntimeFault) as ctx:
            run("""
                .consts 1 0
                CONST 0
                CONST 1
                DIV
                HALT
            """)
        exc = ctx.exception
        self.assertEqual(type(exc), RuntimeFault)
        self.assertEqual(exc.pc, 6)
        self.assertEqual(exc.step, 2)
        self.assertIn("pc=6 step=2", str(exc))

    def test_mod_by_zero(self):
        with self.assertRaises(RuntimeFault):
            run("""
                .consts 1 0
                CONST 0
                CONST 1
                MOD
                HALT
            """)

    def test_empty_halt(self):
        with self.assertRaises(EmptyHalt):
            run("HALT")

    def test_ret_without_caller(self):
        with self.assertRaises(RuntimeFault):
            run("RET")

    def test_stack_underflow(self):
        with self.assertRaises(RuntimeFault):
            run("ADD")

    def test_jump_to_code_end_faults_at_runtime(self):
        # Passes verification (target == code_end) but faults on fetch.
        with self.assertRaises(RuntimeFault) as ctx:
            run("""
                JMP done
                HALT
                done:
            """)
        self.assertIn("out of code range", str(ctx.exception))


class TestLimits(unittest.TestCase):
    def test_stack_overflow(self):
        lines = [".consts 0"] + ["CONST 0"] * 257 + ["HALT"]
        with self.assertRaises(StackOverflow) as ctx:
            run("\n".join(lines))
        self.assertEqual(ctx.exception.step, 256)

    def test_frame_overflow_depth_65(self):
        # Acceptance C: main frame + 64 nested calls = depth 65 overflows.
        # 63 calls succeed (frames 2..64); the call attempting frame 65
        # faults at step 63.
        with self.assertRaises(FrameOverflow) as ctx:
            run(INFINITE_RECURSION)
        self.assertEqual(ctx.exception.step, 63)

    def test_frame_overflow_trace_reproducible(self):
        # Acceptance C: identical traces across runs.
        traces = []
        for _ in range(2):
            prog = loads(assemble(INFINITE_RECURSION).serialize())
            out = io.StringIO()
            machine = VM(prog, trace=True, trace_out=out)
            with self.assertRaises(FrameOverflow):
                machine.run()
            traces.append(out.getvalue())
        self.assertEqual(traces[0], traces[1])
        lines = traces[0].splitlines()
        self.assertEqual(len(lines), 64)  # one line per executed step
        self.assertEqual(lines[0], "step=0 pc=0 op=CALL arg=4 stack=[]")
        self.assertEqual(lines[-1], "step=63 pc=4 op=CALL arg=4 stack=[]")

    def test_step_limit_default_is_1e6(self):
        prog = loads(assemble("main: JMP main").serialize())
        machine = VM(prog)
        with self.assertRaises(StepLimit) as ctx:
            machine.run()
        self.assertEqual(ctx.exception.step, 1_000_000)

    def test_step_limit_configurable(self):
        prog = loads(assemble("main: JMP main").serialize())
        machine = VM(prog, step_limit=1000)
        with self.assertRaises(StepLimit) as ctx:
            machine.run()
        self.assertEqual(ctx.exception.step, 1000)


if __name__ == "__main__":
    unittest.main()
