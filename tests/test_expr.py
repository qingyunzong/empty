"""Acceptance A: 500 random expression trees of depth <= 3, compiled to
bytecode, must agree with direct Python evaluation."""

import random
import struct
import unittest

from tinyvm import isa
from tinyvm.program import Program, loads
from tinyvm.vm import VM

OP = isa.OPCODES
OPS = ["ADD", "SUB", "MUL", "DIV", "MOD"]


def gen_expr(rng, depth):
    """Generate an expression tree: int leaf or (op, left, right)."""
    if depth == 0 or rng.random() < 0.3:
        return rng.randint(-20, 20)
    op = rng.choice(OPS)
    return (op, gen_expr(rng, depth - 1), gen_expr(rng, depth - 1))


def evaluate(expr):
    if isinstance(expr, int):
        return expr
    op, left, right = expr
    lhs, rhs = evaluate(left), evaluate(right)
    if op == "ADD":
        return lhs + rhs
    if op == "SUB":
        return lhs - rhs
    if op == "MUL":
        return lhs * rhs
    if rhs == 0:
        raise ZeroDivisionError
    if op == "DIV":
        return lhs // rhs
    return lhs % rhs


def compile_expr(expr):
    """Compile to (consts, code) using post-order emission."""
    consts = []
    code = bytearray()

    def emit(node):
        if isinstance(node, int):
            consts.append(node)
            code.append(OP["CONST"])
            code.extend(struct.pack("<H", len(consts) - 1))
            return
        op, left, right = node
        emit(left)
        emit(right)
        code.append(OP[op])

    emit(expr)
    code.append(OP["HALT"])
    return consts, bytes(code)


class TestExpressionEquivalence(unittest.TestCase):
    def test_500_random_expressions_depth_up_to_3(self):
        rng = random.Random(20261001)
        checked = 0
        while checked < 500:
            depth = rng.randint(0, 3)
            expr = gen_expr(rng, depth)
            try:
                expected = evaluate(expr)
            except ZeroDivisionError:
                continue  # skip expressions that divide by zero
            consts, code = compile_expr(expr)
            prog = loads(Program(consts=consts, nlocals=0, code=code).serialize())
            machine = VM(prog)
            result = machine.run()
            self.assertEqual(
                result, expected, "mismatch on expression %r" % (expr,)
            )
            checked += 1
        self.assertEqual(checked, 500)


if __name__ == "__main__":
    unittest.main()
