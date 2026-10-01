import unittest

from peepbc import Instr, Program, optimize, verify


def I(op, arg=None):
    return Instr(op, arg)


class TestVerify(unittest.TestCase):
    def test_jump_out_of_range(self):
        p = Program([], [I("JMP", 5)])
        self.assertTrue(verify(p))

    def test_const_index_out_of_range(self):
        p = Program([], [I("CONST", 0), I("HALT")])
        self.assertTrue(verify(p))

    def test_depth_limit_ok(self):
        p = Program([1], [I("CONST", 0)] * 256 + [I("HALT")])
        self.assertEqual(verify(p), [])

    def test_depth_limit_exceeded(self):
        """Acceptance D: a program whose stack can exceed 256 is rejected."""
        p = Program([1], [I("CONST", 0)] * 257 + [I("HALT")])
        errors = verify(p)
        self.assertTrue(errors)
        self.assertIn("exceeds limit", errors[0])

    def test_depth_growth_in_loop_detected(self):
        p = Program([1], [I("CONST", 0), I("JMP", 0)])
        self.assertTrue(verify(p))

    def test_conditional_branch_depth(self):
        # one branch pushes 300 times
        body = [I("CONST", 0), I("JZ", 3), I("HALT")] + [I("CONST", 0)] * 300
        p = Program([0], body)
        self.assertTrue(verify(p))

    def test_optimizer_output_verifies(self):
        p = Program([3, 4], [I("CONST", 0), I("CONST", 1), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual(verify(opt), [])


if __name__ == "__main__":
    unittest.main()
