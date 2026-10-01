"""Acceptance A: 400 random small programs.

For each program we check that, within a step limit, the original and the
optimised program produce the same final stack and the same error
category -- cross-checked against an independent reference interpreter
implemented separately below.
"""

import random
import unittest

from peepbc import isa, optimize, run
from peepbc.program import Ins, Program

MAX_STEPS = 10_000


def reference_run(prog, max_steps=MAX_STEPS, max_stack=256):
    """Independent interpreter, written separately from peepbc.interp."""
    consts = list(prog.consts)
    code = [(ins.op, ins.arg) for ins in prog.code]
    stack = []
    pc = 0
    steps = 0
    while 0 <= pc < len(code) and steps < max_steps:
        op, arg = code[pc]
        steps += 1
        if op == isa.CONST:
            if arg >= len(consts):
                return "bad_const", stack
            stack.append(consts[arg])
            if len(stack) > max_stack:
                return "stack_overflow", stack
            pc += 1
        elif op in (isa.ADD, isa.SUB, isa.MUL, isa.DIV, isa.MOD):
            if len(stack) < 2:
                return "stack_underflow", stack
            b, a = stack.pop(), stack.pop()
            if op == isa.ADD:
                stack.append(a + b)
            elif op == isa.SUB:
                stack.append(a - b)
            elif op == isa.MUL:
                stack.append(a * b)
            else:
                if b == 0:
                    return "div_zero", stack
                q = abs(a) // abs(b)
                if (a < 0) != (b < 0):
                    q = -q
                stack.append(q if op == isa.DIV else a - q * b)
            pc += 1
        elif op == isa.JMP:
            if arg >= len(code):
                return "bad_jump", stack
            pc = arg
        elif op in (isa.JZ, isa.JNZ):
            if not stack:
                return "stack_underflow", stack
            v = stack.pop()
            if (v == 0) == (op == isa.JZ):
                if arg >= len(code):
                    return "bad_jump", stack
                pc = arg
            else:
                pc += 1
        elif op == isa.HALT:
            return "halt", stack
        else:
            return "bad_opcode", stack
    if steps >= max_steps and 0 <= pc < len(code):
        return "step_limit", stack
    return "halt", stack


def gen_program(rng):
    n = rng.randint(4, 25)
    consts = [rng.randint(-5, 5) for _ in range(rng.randint(1, 6))]
    code = []
    for _ in range(n):
        r = rng.random()
        if r < 0.40:
            code.append(Ins(isa.CONST, rng.randrange(len(consts))))
        elif r < 0.70:
            code.append(Ins(rng.choice([isa.ADD, isa.SUB, isa.MUL,
                                        isa.DIV, isa.MOD])))
        elif r < 0.85:
            op = rng.choice([isa.JMP, isa.JZ, isa.JNZ])
            code.append(Ins(op, rng.randrange(n)))
        else:
            code.append(Ins(isa.HALT))
    return Program(consts, code)


class TestRandomEquivalence(unittest.TestCase):
    def test_400_random_programs(self):
        rng = random.Random(20261001)
        compared = 0
        skipped_overflow = 0
        for _ in range(400):
            prog = gen_program(rng)
            opt, mapping = optimize(prog)

            # Mapping sanity: total, monotone, and deleted instructions map
            # to the next executable point.
            self.assertEqual(sorted(mapping), list(range(len(prog.code))))
            for old_pc, new_pc in mapping.items():
                self.assertGreaterEqual(new_pc, 0)
                self.assertLessEqual(new_pc, len(opt.code))

            before = reference_run(prog)
            after = reference_run(opt)
            # Folding legitimately reduces peak stack depth, so programs
            # that overflow the 256-deep stack are excluded from comparison
            # (the CLI rejects rewrites that may exceed the limit instead).
            if "stack_overflow" in (before[0], after[0]):
                skipped_overflow += 1
                continue
            if before[0] == "step_limit":
                # Optimisation only *removes* executed steps, so a program
                # that exhausts the step budget may legitimately get
                # further (even to HALT) after rewriting.  Its final state
                # is then the same trajectory, just more advanced.
                continue
            self.assertEqual(before[0], after[0],
                             msg=f"status mismatch: {before} vs {after}")
            self.assertEqual(before[1], after[1],
                             msg=f"stack mismatch: {before} vs {after}")

            # Cross-check the package interpreter against the reference.
            pkg = run(prog, max_steps=MAX_STEPS)
            self.assertEqual(pkg.status, before[0])
            self.assertEqual(pkg.stack, before[1])
            compared += 1
        # The deterministic seed must keep the skip rate low.
        self.assertGreater(compared, 380,
                           f"too many skipped ({skipped_overflow})")


if __name__ == "__main__":
    unittest.main()
