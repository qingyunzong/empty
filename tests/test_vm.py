"""Runtime semantics tests (acceptance item C lives here)."""

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
from tinyvm.isa import encode
from tinyvm.loader import dump_program, load
from tinyvm.vm import MAX_FRAMES, MAX_STACK, VM

from helpers import factorial_program


def run(consts, items, **kwargs):
    program = load(dump_program(consts, assemble(items)))
    return VM(program, **kwargs).run()


class ArithmeticTests(unittest.TestCase):
    def test_basic_arithmetic(self):
        # (7 + 3) * (10 - 4) = 60
        result = run(
            [7, 3, 10, 4],
            [
                ("CONST", 0), ("CONST", 1), ("ADD",),
                ("CONST", 2), ("CONST", 3), ("SUB",),
                ("MUL",),
                ("HALT",),
            ],
        )
        self.assertEqual(result, 60)

    def test_div_truncates_toward_zero(self):
        for a, b, expected in [(7, 2, 3), (-7, 2, -3), (7, -2, -3), (-7, -2, 3)]:
            result = run([a, b], [("CONST", 0), ("CONST", 1), ("DIV",), ("HALT",)])
            self.assertEqual(result, expected, msg=f"{a}/{b}")

    def test_mod_sign_of_dividend(self):
        for a, b, expected in [(7, 2, 1), (-7, 2, -1), (7, -2, 1), (-7, -2, -1)]:
            result = run([a, b], [("CONST", 0), ("CONST", 1), ("MOD",), ("HALT",)])
            self.assertEqual(result, expected, msg=f"{a}%{b}")

    def test_locals_roundtrip(self):
        result = run(
            [41, 1],
            [
                ("CONST", 0), ("STORE", 3),
                ("LOAD", 3), ("CONST", 1), ("ADD",),
                ("HALT",),
            ],
        )
        self.assertEqual(result, 42)


class FaultTests(unittest.TestCase):
    def test_div_by_zero(self):
        with self.assertRaises(RuntimeFault):
            run([1, 0], [("CONST", 0), ("CONST", 1), ("DIV",), ("HALT",)])

    def test_mod_by_zero(self):
        with self.assertRaises(RuntimeFault):
            run([1, 0], [("CONST", 0), ("CONST", 1), ("MOD",), ("HALT",)])

    def test_stack_underflow(self):
        with self.assertRaises(RuntimeFault):
            run([], [("ADD",), ("HALT",)])

    def test_empty_halt(self):
        with self.assertRaises(EmptyHalt):
            run([], [("HALT",)])

    def test_ret_without_caller(self):
        with self.assertRaises(RuntimeFault):
            run([], [("RET",)])

    def test_fall_off_code_end(self):
        with self.assertRaises(RuntimeFault):
            run([], [("JMP", 4), ("HALT",)])  # jumps to code_end

    def test_stack_overflow(self):
        items = [("CONST", 0)] * (MAX_STACK + 1) + [("HALT",)]
        with self.assertRaises(StackOverflow):
            run([1], items)

    def test_step_limit(self):
        with self.assertRaises(StepLimit):
            run([], ["loop", ("JMP", "loop")])


class FrameTests(unittest.TestCase):
    def test_factorial_computes(self):
        program = load(factorial_program(10))
        self.assertEqual(VM(program).run(), 3628800)

    def test_frame_overflow_at_depth_65(self):
        # Main frame + nested CALLs: the 65th frame exceeds the limit of 64.
        program = load(factorial_program(100))
        with self.assertRaises(FrameOverflow):
            VM(program).run()

    def test_frame_overflow_trace_is_reproducible(self):
        traces = []
        for _ in range(2):
            program = load(factorial_program(100))
            buffer = io.StringIO()
            with self.assertRaises(FrameOverflow):
                VM(program, trace=True, trace_file=buffer).run()
            traces.append(buffer.getvalue())
        self.assertEqual(traces[0], traces[1])
        self.assertIn("CALL", traces[0])
        # The trace records the failing CALL attempt as its last line.
        self.assertIn(f"frames={MAX_FRAMES}", traces[0].splitlines()[-1])

    def test_trace_goes_to_stderr_prefix_on_fault(self):
        program = load(dump_program([1, 0], assemble(
            [("CONST", 0), ("CONST", 1), ("DIV",), ("HALT",)]
        )))
        buffer = io.StringIO()
        with self.assertRaises(RuntimeFault):
            VM(program, trace=True, trace_file=buffer).run()
        lines = buffer.getvalue().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertIn("DIV", lines[-1])


if __name__ == "__main__":
    unittest.main()
