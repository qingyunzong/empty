import unittest

from peepbc import Instr, Program, optimize, run, verify


def P(consts, code):
    return Program(list(consts), list(code))


def I(op, arg=None):
    return Instr(op, arg)


class TestFolding(unittest.TestCase):
    def test_const_fold_add(self):
        p = P([3, 4], [I("CONST", 0), I("CONST", 1), I("ADD"), I("HALT")])
        opt, m = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["CONST", "HALT"])
        self.assertEqual(opt.consts[opt.code[0].arg], 7)
        self.assertEqual(run(opt).stack, [7])

    def test_fold_chain_to_fixpoint(self):
        # 1 + 2 + 3 folds in two passes
        p = P([1, 2, 3], [I("CONST", 0), I("CONST", 1), I("ADD"),
                          I("CONST", 2), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["CONST", "HALT"])
        self.assertEqual(opt.consts[opt.code[0].arg], 6)

    def test_no_fold_across_label(self):
        # pc 3 (the second CONST of the pattern) is a jump target:
        # folding would change the meaning of jumping there, so the
        # pattern must not be folded.
        p = P([0, 3, 4], [I("CONST", 0), I("JZ", 3), I("CONST", 1),
                          I("CONST", 2), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertIn("ADD", [i.op for i in opt.code])

    def test_fold_allowed_when_label_on_first_const(self):
        # A label on the first CONST is safe: jumping there still pushes
        # a, b and adds them, which the folded CONST reproduces.
        p = P([0, 3, 4], [I("CONST", 0), I("JZ", 2), I("CONST", 1),
                          I("CONST", 2), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertNotIn("ADD", [i.op for i in opt.code])
        self.assertEqual(run(opt).category, run(p).category)
        self.assertEqual(run(opt).stack, run(p).stack)


class TestDivZeroPreserved(unittest.TestCase):
    """Acceptance B: 0/0 must not be folded; runtime still faults."""

    def test_div_zero_not_folded(self):
        p = P([0], [I("CONST", 0), I("CONST", 0), I("DIV"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code],
                         ["CONST", "CONST", "DIV", "HALT"])
        self.assertEqual(run(opt).category, "divzero")

    def test_mod_zero_not_folded(self):
        p = P([5, 0], [I("CONST", 0), I("CONST", 1), I("MOD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code],
                         ["CONST", "CONST", "MOD", "HALT"])
        self.assertEqual(run(opt).category, "divzero")

    def test_nonzero_div_folds(self):
        p = P([7, 2], [I("CONST", 0), I("CONST", 1), I("DIV"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["CONST", "HALT"])
        self.assertEqual(opt.consts[opt.code[0].arg], 3)


class TestIdentity(unittest.TestCase):
    def test_add_zero_removed(self):
        p = P([9, 0], [I("CONST", 0), I("CONST", 1), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        # CONST 9; CONST 0; ADD is folded to CONST 9 by rule 1 anyway
        self.assertEqual([i.op for i in opt.code], ["CONST", "HALT"])
        self.assertEqual(run(opt).stack, [9])

    def test_identity_after_arith(self):
        # (x) ; CONST 0 ; ADD  ->  x  (depth guaranteed by preceding arith)
        p = P([2, 3, 0], [I("CONST", 0), I("CONST", 1), I("MUL"),
                          I("CONST", 2), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["CONST", "HALT"])
        self.assertEqual(run(opt).stack, [6])

    def test_identity_not_applied_on_empty_stack(self):
        # CONST 0 ; ADD with empty stack must keep the underflow fault.
        p = P([0], [I("CONST", 0), I("ADD"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["CONST", "ADD", "HALT"])
        self.assertEqual(run(opt).category, "underflow")

    def test_mul_one_removed(self):
        p = P([8, 1], [I("CONST", 0), I("CONST", 1), I("MUL"), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual(run(opt).stack, [8])


class TestJmpChainAndDce(unittest.TestCase):
    def test_chain_compression(self):
        p = P([1], [I("JMP", 2), I("JMP", 3), I("JMP", 4),
                    I("CONST", 0), I("HALT")])
        opt, _ = optimize(p)
        # the JMP chain collapses; everything between JMP and HALT is dead
        self.assertEqual([i.op for i in opt.code], ["JMP", "HALT"])
        self.assertEqual(opt.code[0].arg, 1)
        self.assertEqual(run(opt).stack, [])

    def test_chain_cycle_safe(self):
        p = P([], [I("JMP", 1), I("JMP", 0)])
        opt, _ = optimize(p)
        self.assertEqual(run(opt, max_steps=50).category, "step_limit")

    def test_dead_code_removed_until_label(self):
        p = P([7], [I("JMP", 3), I("CONST", 0), I("MUL"),
                    I("CONST", 0), I("HALT")])
        opt, m = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["JMP", "CONST", "HALT"])
        self.assertEqual(run(opt).stack, [7])


class TestMapping(unittest.TestCase):
    """Acceptance C: deleted pcs map to the next executable point and
    jumps are retargeted through the mapping."""

    def test_deleted_pc_maps_to_next_executable(self):
        # pcs 1,2 (dead) are deleted; pc 3 is the next executable point.
        p = P([7], [I("JMP", 3), I("CONST", 0), I("ADD"),
                    I("CONST", 0), I("HALT")])
        opt, m = optimize(p)
        self.assertEqual([i.op for i in opt.code], ["JMP", "CONST", "HALT"])
        self.assertEqual(m[1], 1)  # -> old pc 3, now at new pc 1
        self.assertEqual(m[2], 1)
        self.assertEqual(m[3], 1)
        self.assertEqual(m[4], 2)

    def test_jump_target_beyond_deleted_region(self):
        # JMP at pc 0 targets pc 4; pcs 1..3 are dead and removed.
        p = P([1], [I("JMP", 4), I("CONST", 0), I("CONST", 0), I("ADD"),
                    I("CONST", 0), I("HALT")])
        opt, m = optimize(p)
        self.assertEqual(opt.code[0], I("JMP", m[4]))
        self.assertEqual(opt.code[0].arg, 1)
        self.assertEqual(run(opt).stack, [1])

    def test_jump_retargeted_after_fold(self):
        # JZ targets the ADD inside a foldable pattern? No: labels block
        # folding. Here JZ targets the instruction *after* a folded
        # pattern and must be remapped to the shifted pc.
        p = P([1, 2, 0], [I("CONST", 2), I("JZ", 5),
                          I("CONST", 0), I("CONST", 1), I("ADD"),
                          I("CONST", 0), I("HALT")])
        opt, m = optimize(p)
        self.assertEqual(opt.code[1], I("JZ", m[5]))
        self.assertEqual(m[5], 3)  # folded 3 instrs -> 1, shifting by 2
        self.assertEqual(run(opt).stack, [1])

    def test_tail_deletion_maps_to_end(self):
        p = P([], [I("HALT"), I("JMP", 0)])
        opt, m = optimize(p)
        self.assertEqual(m[1], len(opt.code))

    def test_optimized_program_always_verifies(self):
        p = P([1, 2, 0], [I("CONST", 2), I("JZ", 5),
                          I("CONST", 0), I("CONST", 1), I("ADD"),
                          I("CONST", 0), I("HALT")])
        opt, _ = optimize(p)
        self.assertEqual(verify(opt), [])


if __name__ == "__main__":
    unittest.main()
