import unittest

from peepbc import isa, optimize, run, verify
from peepbc.asm import assemble
from peepbc.program import Ins, Program


def ops(prog):
    return [ins.op for ins in prog.code]


class TestConstantFolding(unittest.TestCase):
    def test_fold_add(self):
        prog = assemble("CONST 2\nCONST 3\nADD\nHALT")
        opt, mapping = optimize(prog)
        self.assertEqual(ops(opt), [isa.CONST, isa.HALT])
        self.assertEqual(opt.consts[opt.code[0].arg], 5)
        self.assertEqual(run(opt).stack, [5])
        self.assertEqual(mapping, {0: 0, 1: 0, 2: 0, 3: 1})

    def test_fold_all_binops(self):
        for text, expect in [
            ("CONST 8\nCONST 2\nSUB\nHALT", 6),
            ("CONST 8\nCONST 2\nMUL\nHALT", 16),
            ("CONST 7\nCONST 2\nDIV\nHALT", 3),
            ("CONST 7\nCONST 2\nMOD\nHALT", 1),
            ("CONST -7\nCONST 2\nDIV\nHALT", -3),
            ("CONST -7\nCONST 2\nMOD\nHALT", -1),
        ]:
            opt, _ = optimize(assemble(text))
            self.assertEqual(ops(opt), [isa.CONST, isa.HALT], text)
            self.assertEqual(run(opt).stack, [expect], text)

    def test_acceptance_B_div_zero_not_folded(self):
        # 0/0 must not be folded; the runtime div_zero fault is preserved.
        for op in ("DIV", "MOD"):
            prog = assemble(f"CONST 0\nCONST 0\n{op}\nHALT")
            opt, _ = optimize(prog)
            self.assertEqual(
                ops(opt),
                [isa.CONST, isa.CONST, isa.BY_NAME[op], isa.HALT],
                msg=op,
            )
            self.assertEqual(run(opt).status, "div_zero", op)

    def test_fold_chain_across_rounds(self):
        # (1+2)*(3+4) folds to 21 over multiple rounds.
        prog = assemble(
            "CONST 1\nCONST 2\nADD\nCONST 3\nCONST 4\nADD\nMUL\nHALT"
        )
        opt, _ = optimize(prog)
        self.assertEqual(ops(opt), [isa.CONST, isa.HALT])
        self.assertEqual(run(opt).stack, [21])

    def test_no_fold_across_label(self):
        # ADD is a jump target: the triple must not be folded.
        prog = assemble(
            "CONST 0\nJZ tgt\nCONST 10\nCONST 20\ntgt: ADD\nHALT"
        )
        opt, _ = optimize(prog)
        self.assertEqual(ops(opt), [isa.CONST, isa.JZ, isa.CONST,
                                    isa.CONST, isa.ADD, isa.HALT])


class TestIdentities(unittest.TestCase):
    def test_add_zero_removed(self):
        # The x in "x + 0" comes from an un-foldable DIV, so the identity
        # rule (not constant folding) is what removes CONST 0; ADD.
        prog = assemble("CONST 5\nCONST 0\nDIV\nCONST 0\nADD\nHALT")
        opt, mapping = optimize(prog)
        self.assertEqual(ops(opt), [isa.CONST, isa.CONST, isa.DIV, isa.HALT])
        self.assertEqual(run(opt).status, "div_zero")
        # deleted CONST 0 / ADD map to the next executable point (HALT @1)
        self.assertEqual(mapping[3], 3)
        self.assertEqual(mapping[4], 3)

    def test_mul_one_removed(self):
        prog = assemble("CONST 5\nCONST 1\nMUL\nHALT")
        opt, _ = optimize(prog)
        self.assertEqual(ops(opt), [isa.CONST, isa.HALT])
        self.assertEqual(run(opt).stack, [5])

    def test_identity_not_applied_on_label(self):
        prog = assemble("JMP tgt\nCONST 9\ntgt: CONST 0\nADD\nHALT")
        opt, _ = optimize(prog)
        # CONST 0 is a jump target -> identity rule must not remove it
        self.assertIn(isa.ADD, ops(opt))


class TestJumpChainsAndDeadCode(unittest.TestCase):
    def test_jmp_chain_compressed(self):
        prog = assemble(
            "JMP a\n"
            "a: JMP b\n"
            "b: CONST 1\n"
            "HALT"
        )
        opt, _ = optimize(prog)
        # first jump now targets the CONST directly
        self.assertEqual(opt.code[0].op, isa.JMP)
        tgt = opt.code[0].arg
        self.assertEqual(opt.code[tgt].op, isa.CONST)
        self.assertEqual(run(opt).stack, [1])

    def test_dead_code_removed(self):
        prog = assemble(
            "JMP live\n"
            "CONST 9\n"     # dead
            "CONST 8\n"     # dead
            "live: CONST 1\n"
            "HALT\n"
            "CONST 7"       # dead, after HALT, no label -> maps to end
        )
        opt, mapping = optimize(prog)
        self.assertEqual(ops(opt), [isa.JMP, isa.CONST, isa.HALT])
        self.assertEqual(opt.code[0].arg, 1)
        self.assertEqual(mapping, {0: 0, 1: 1, 2: 1, 3: 1, 4: 2, 5: 3})

    def test_acceptance_C_jump_to_deleted_maps_correctly(self):
        # old pc 1 is dead code; its mapping must be the next executable
        # point, and the JMP must be retargeted through the same mapping.
        prog = assemble(
            "JMP live\n"
            "CONST 9\n"      # old pc 1: deleted
            "live: CONST 1\n"
            "HALT"
        )
        opt, mapping = optimize(prog)
        self.assertEqual(mapping[1], mapping[2])  # deleted -> next executable
        self.assertEqual(opt.code[0].arg, mapping[2])
        self.assertEqual(run(opt).stack, [1])

    def test_jmp_self_loop_untouched(self):
        prog = assemble("loop: JMP loop")
        opt, _ = optimize(prog)
        self.assertEqual(ops(opt), [isa.JMP])
        self.assertEqual(opt.code[0].arg, 0)

    def test_optimized_programs_verify_clean(self):
        samples = [
            "CONST 2\nCONST 3\nADD\nCONST 0\nADD\nHALT",
            "JMP a\na: JMP b\nb: CONST 1\nCONST 1\nMUL\nHALT",
            "CONST 4\nCONST 2\nDIV\nCONST 0\nJZ 5\nCONST 3\nHALT",
        ]
        for text in samples:
            opt, _ = optimize(assemble(text))
            self.assertEqual(verify(opt), [], text)


if __name__ == "__main__":
    unittest.main()
