import unittest

from peepbc.asm import assemble
from peepbc.interp import run, trunc_div


class TestInterp(unittest.TestCase):
    def test_arithmetic(self):
        prog = assemble("CONST 7\nCONST 3\nADD\nCONST 2\nMUL\nHALT")
        res = run(prog)
        self.assertEqual(res.status, "halt")
        self.assertEqual(res.stack, [20])

    def test_sub_and_mod(self):
        prog = assemble("CONST 7\nCONST 3\nSUB\nCONST 3\nMOD\nHALT")
        self.assertEqual(run(prog).stack, [1])  # 4 % 3

    def test_truncating_division(self):
        self.assertEqual(trunc_div(-7, 2), -3)
        self.assertEqual(trunc_div(7, -2), -3)
        prog = assemble("CONST -7\nCONST 2\nDIV\nHALT")
        self.assertEqual(run(prog).stack, [-3])
        prog = assemble("CONST -7\nCONST 2\nMOD\nHALT")
        self.assertEqual(run(prog).stack, [-1])  # C-style: sign of dividend

    def test_div_zero_fault(self):
        prog = assemble("CONST 1\nCONST 0\nDIV\nHALT")
        res = run(prog)
        self.assertEqual(res.status, "div_zero")
        self.assertEqual(res.stack, [])

    def test_mod_zero_fault(self):
        prog = assemble("CONST 1\nCONST 0\nMOD\nHALT")
        self.assertEqual(run(prog).status, "div_zero")

    def test_jumps(self):
        # if 0 == 0 then push 1 else push 2
        prog = assemble(
            "CONST 0\nJZ yes\nCONST 2\nJMP end\nyes: CONST 1\nend: HALT"
        )
        self.assertEqual(run(prog).stack, [1])

    def test_jnz_loop(self):
        # 0 CONST 3   1 CONST 1   2 SUB   3 CONST 0   4 JNZ 1   5 HALT
        # JNZ pops the 0 (never taken); result: 3-1 = 2 on the stack.
        prog = assemble(
            "CONST 3\nCONST 1\nSUB\nCONST 0\nJNZ 1\nHALT"
        )
        res = run(prog)
        self.assertEqual(res.status, "halt")
        self.assertEqual(res.stack, [2])

    def test_step_limit(self):
        prog = assemble("loop: JMP loop")
        res = run(prog, max_steps=100)
        self.assertEqual(res.status, "step_limit")
        self.assertEqual(res.steps, 100)

    def test_stack_overflow(self):
        prog = assemble("loop: CONST 1\nJMP loop")
        res = run(prog, max_steps=100_000, max_stack=256)
        self.assertEqual(res.status, "stack_overflow")
        self.assertEqual(len(res.stack), 257)

    def test_stack_underflow(self):
        prog = assemble("ADD\nHALT")
        self.assertEqual(run(prog).status, "stack_underflow")

    def test_bad_jump(self):
        prog = assemble("JMP 99")
        self.assertEqual(run(prog).status, "bad_jump")

    def test_fall_off_end_is_halt(self):
        prog = assemble("CONST 5")
        res = run(prog)
        self.assertEqual(res.status, "halt")
        self.assertEqual(res.stack, [5])


if __name__ == "__main__":
    unittest.main()
