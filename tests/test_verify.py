import unittest

from peepbc import isa, verify
from peepbc.asm import assemble
from peepbc.program import Ins, Program


class TestVerify(unittest.TestCase):
    def test_good_program(self):
        prog = assemble("CONST 1\nCONST 2\nADD\nHALT")
        self.assertEqual(verify(prog), [])

    def test_jump_out_of_bounds(self):
        prog = assemble("JMP 42")
        errors = verify(prog)
        self.assertTrue(any("jump target" in e for e in errors))

    def test_const_index_out_of_range(self):
        prog = Program(consts=[1], code=[Ins(isa.CONST, 5), Ins(isa.HALT)])
        errors = verify(prog)
        self.assertTrue(any("CONST index" in e for e in errors))

    def test_stack_overflow_detected(self):
        prog = assemble("\n".join(["CONST 1"] * 257 + ["HALT"]))
        errors = verify(prog)
        self.assertTrue(any("exceed" in e for e in errors))

    def test_exactly_256_is_ok(self):
        prog = assemble("\n".join(["CONST 1"] * 256 + ["HALT"]))
        self.assertEqual(verify(prog), [])

    def test_unbounded_loop_detected(self):
        prog = assemble("loop: CONST 1\nJMP loop")
        errors = verify(prog)
        self.assertTrue(any("exceed" in e for e in errors))

    def test_balanced_loop_ok(self):
        # push 1, push 1, add, drop via JZ-pop; depth stays bounded
        prog = assemble(
            "loop: CONST 1\nCONST 1\nADD\nJZ loop\nJMP loop"
        )
        self.assertEqual(verify(prog), [])

    def test_underflow_detected(self):
        prog = assemble("ADD\nHALT")
        errors = verify(prog)
        self.assertTrue(any("underflow" in e for e in errors))

    def test_conditional_branch_depth(self):
        # depth 1 at the JZ; both successors fine
        prog = assemble("CONST 0\nJZ end\nend: HALT")
        self.assertEqual(verify(prog), [])


if __name__ == "__main__":
    unittest.main()
