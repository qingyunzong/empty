"""Acceptance item A: 500 random expressions of depth <= 3, compiled vs
directly evaluated, must agree."""

import random
import unittest

from tinyvm.compiler import build_program
from tinyvm.loader import load
from tinyvm.vm import VM

from helpers import eval_expr

OPS = "+-*/%"


def gen_expr(depth, rng):
    if depth == 0 or rng.random() < 0.35:
        return ("const", rng.randint(-20, 20))
    op = rng.choice(OPS)
    return (op, gen_expr(depth - 1, rng), gen_expr(depth - 1, rng))


class CompiledVsEvaluatedTests(unittest.TestCase):
    def test_500_random_expressions_agree(self):
        rng = random.Random(20261001)
        checked = 0
        while checked < 500:
            depth = rng.randint(1, 3)
            expr = gen_expr(depth, rng)
            try:
                expected = eval_expr(expr)
            except ZeroDivisionError:
                continue  # not a valid test case; the VM would fault too
            program = load(build_program(expr))
            result = VM(program).run()
            self.assertEqual(result, expected, msg=f"expr={expr!r}")
            checked += 1
        self.assertEqual(checked, 500)

    def test_division_by_zero_expression_faults_in_vm(self):
        expr = ("/", ("const", 5), ("-", ("const", 3), ("const", 3)))
        program = load(build_program(expr))
        from tinyvm.errors import RuntimeFault

        with self.assertRaises(RuntimeFault):
            VM(program).run()


if __name__ == "__main__":
    unittest.main()
