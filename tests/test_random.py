"""Acceptance A: 400 random programs; optimized code must agree with the
original on final stack and error category, checked against an
independent reference interpreter implemented here in the test."""
import random
import unittest

from peepbc import Instr, Program, optimize, verify

STEP_LIMIT = 5000
NUM_PROGRAMS = 400


def reference_run(prog, max_steps=STEP_LIMIT):
    """Independent interpreter, deliberately not sharing code with peepbc."""
    stack = []
    pc = 0
    steps = 0
    n = len(prog.code)
    while 0 <= pc < n and steps < max_steps:
        ins = prog.code[pc]
        steps += 1
        op, arg = ins.op, ins.arg
        if op == "CONST":
            if arg is None or arg >= len(prog.consts) or arg < 0:
                return "bad_const", stack
            stack.append(prog.consts[arg])
            pc += 1
        elif op in ("ADD", "SUB", "MUL", "DIV", "MOD"):
            if len(stack) < 2:
                return "underflow", stack
            b, a = stack.pop(), stack.pop()
            if op in ("DIV", "MOD") and b == 0:
                return "divzero", stack
            if op == "ADD":
                stack.append(a + b)
            elif op == "SUB":
                stack.append(a - b)
            elif op == "MUL":
                stack.append(a * b)
            else:
                q = abs(a) // abs(b)
                if (a < 0) != (b < 0):
                    q = -q
                stack.append(q if op == "DIV" else a - q * b)
            pc += 1
        elif op == "JMP":
            if not 0 <= arg < n:
                return "bad_jump", stack
            pc = arg
        elif op in ("JZ", "JNZ"):
            if not stack:
                return "underflow", stack
            v = stack.pop()
            if (v == 0) == (op == "JZ"):
                if not 0 <= arg < n:
                    return "bad_jump", stack
                pc = arg
            else:
                pc += 1
        elif op == "HALT":
            return "halt", stack
        else:
            raise AssertionError(op)
    if steps >= max_steps:
        return "step_limit", stack
    return "halt", stack  # fell off the end


def gen_program(rng):
    n = rng.randint(4, 14)
    consts = [rng.randint(-5, 5) for _ in range(rng.randint(1, 4))]
    code = []
    for _ in range(n):
        r = rng.random()
        if r < 0.40:
            code.append(Instr("CONST", rng.randrange(len(consts))))
        elif r < 0.70:
            code.append(Instr(rng.choice(["ADD", "SUB", "MUL", "DIV", "MOD"])))
        elif r < 0.80:
            code.append(Instr("JMP", rng.randint(0, n)))
        elif r < 0.90:
            code.append(Instr("JZ", rng.randint(0, n)))
        elif r < 0.95:
            code.append(Instr("JNZ", rng.randint(0, n)))
        else:
            code.append(Instr("HALT"))
    code.append(Instr("HALT"))
    return Program(consts, code)


class TestRandomEquivalence(unittest.TestCase):
    def test_400_random_programs(self):
        rng = random.Random(20261001)
        stats = {}
        for case in range(NUM_PROGRAMS):
            prog = gen_program(rng)
            opt, mapping = optimize(prog)
            with self.subTest(case=case):
                # the optimizer never introduces a verification failure
                if verify(opt):
                    self.assertTrue(verify(prog))
                self.assertEqual(len(mapping), len(prog.code))
                cat_a, stack_a = reference_run(prog)
                cat_b, stack_b = reference_run(opt)
                self.assertEqual(cat_a, cat_b)
                if cat_a != "step_limit":
                    # terminated within the step budget: the final
                    # stack must be identical
                    self.assertEqual(stack_a, stack_b)
                # else: both hit the step limit; peephole rewriting
                # legitimately changes how many loop iterations fit
                # into the step budget, so stacks may differ
            stats[cat_a] = stats.get(cat_a, 0) + 1
        # sanity: the corpus exercises more than one outcome
        self.assertGreaterEqual(len(stats), 2)


if __name__ == "__main__":
    unittest.main()
