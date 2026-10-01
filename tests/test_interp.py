import unittest

from peepbc import Instr, Program, run


def prog(consts, *ops):
    code = []
    for op in ops:
        if isinstance(op, tuple):
            code.append(Instr(op[0], op[1]))
        else:
            code.append(Instr(op))
    return Program(list(consts), code)


class TestInterp(unittest.TestCase):
    def test_arithmetic(self):
        p = prog([7, 5], ("CONST", 0), ("CONST", 1), "ADD", "HALT")
        r = run(p)
        self.assertEqual(r.category, "halt")
        self.assertEqual(r.stack, [12])

    def test_div_mod_truncating(self):
        # -7 / 2 == -3, -7 % 2 == -1 (C-style truncation)
        p = prog([-7, 2], ("CONST", 0), ("CONST", 1), "DIV",
                 ("CONST", 0), ("CONST", 1), "MOD", "HALT")
        r = run(p)
        self.assertEqual(r.category, "halt")
        self.assertEqual(r.stack, [-3, -1])

    def test_divzero_fault(self):
        p = prog([1, 0], ("CONST", 0), ("CONST", 1), "DIV", "HALT")
        r = run(p)
        self.assertEqual(r.category, "divzero")

    def test_mod_zero_fault(self):
        p = prog([1, 0], ("CONST", 0), ("CONST", 1), "MOD", "HALT")
        self.assertEqual(run(p).category, "divzero")

    def test_underflow(self):
        p = prog([], "ADD", "HALT")
        self.assertEqual(run(p).category, "underflow")

    def test_jz_jnz(self):
        p = prog([0, 42], ("CONST", 0), ("JZ", 4), ("CONST", 1),
                 ("JMP", 5), ("CONST", 1), "HALT")
        r = run(p)
        self.assertEqual((r.category, r.stack), ("halt", [42]))

    def test_step_limit(self):
        p = prog([], ("JMP", 0))
        self.assertEqual(run(p, max_steps=100).category, "step_limit")

    def test_bad_jump(self):
        p = prog([], ("JMP", 99))
        self.assertEqual(run(p).category, "bad_jump")

    def test_fall_off_end_halts(self):
        p = prog([1], ("CONST", 0))
        r = run(p)
        self.assertEqual((r.category, r.stack), ("halt", [1]))


if __name__ == "__main__":
    unittest.main()
