import unittest

from typedbc import (
    JoinError,
    TypeFault,
    VerifyError,
    parse,
    verify,
)


def asm(text):
    return parse(text)


class TestParse(unittest.TestCase):
    def test_parse_basic(self):
        prog = asm("CONST_INT 1\nCONST_BOOL true\nADD # comment\nHALT\n")
        self.assertEqual([i.op for i in prog], ["CONST_INT", "CONST_BOOL", "ADD", "HALT"])
        self.assertEqual(prog[0].arg, 1)
        self.assertIs(prog[1].arg, True)

    def test_parse_unknown_opcode(self):
        with self.assertRaises(VerifyError):
            asm("FOO\nHALT")

    def test_parse_bad_operand(self):
        with self.assertRaises(VerifyError):
            asm("CONST_INT x\nHALT")
        with self.assertRaises(VerifyError):
            asm("CONST_BOOL maybe\nHALT")
        with self.assertRaises(VerifyError):
            asm("")

    def test_str_roundtrip(self):
        prog = asm("CONST_INT -3\nCONST_BOOL false\nJZ 0\nHALT")
        self.assertEqual(str(prog[0]), "CONST_INT -3")
        self.assertEqual(str(prog[1]), "CONST_BOOL false")
        self.assertEqual(str(prog[2]), "JZ 0")


class TestStructure(unittest.TestCase):
    def test_bad_jump_target(self):
        with self.assertRaises(VerifyError):
            verify(asm("JMP 9\nHALT"))
        with self.assertRaises(VerifyError):
            verify(asm("CONST_BOOL true\nJZ -1\nHALT"))

    def test_fall_off_end(self):
        with self.assertRaises(VerifyError):
            verify(asm("CONST_INT 1"))

    def test_stack_underflow(self):
        with self.assertRaises(VerifyError) as ctx:
            verify(asm("ADD\nHALT"))
        self.assertIn("underflow", str(ctx.exception))

    def test_stack_overflow(self):
        text = "\n".join(["CONST_INT 1"] * 33 + ["HALT"])
        with self.assertRaises(VerifyError) as ctx:
            verify(asm(text))
        self.assertIn("exceeds limit", str(ctx.exception))
        # exactly 32 is fine
        text = "\n".join(["CONST_INT 1"] * 32 + ["HALT"])
        verify(asm(text))


class TestTypes(unittest.TestCase):
    def test_ok_program(self):
        report = verify(asm("CONST_INT 1\nCONST_INT 2\nADD\nCONST_INT 3\nCMP\nNOT\nHALT"))
        self.assertEqual(report.warnings, [])
        self.assertTrue(all(b.reachable for b in report.blocks))
        self.assertEqual(report.blocks[0].exit_stack, ["bool"])

    def test_type_fault_fields(self):
        with self.assertRaises(TypeFault) as ctx:
            verify(asm("CONST_INT 3\nJZ 3\nHALT\nHALT"))
        fault = ctx.exception
        self.assertEqual(fault.pc, 1)
        self.assertEqual(fault.expected, "bool")
        self.assertEqual(fault.actual, "int")
        self.assertEqual(fault.stack, ["int"])

    def test_add_type_fault(self):
        with self.assertRaises(TypeFault) as ctx:
            verify(asm("CONST_INT 1\nCONST_BOOL true\nADD\nHALT"))
        self.assertEqual(ctx.exception.expected, "int")
        self.assertEqual(ctx.exception.actual, "bool")

    def test_not_type_fault(self):
        with self.assertRaises(TypeFault):
            verify(asm("CONST_INT 1\nNOT\nHALT"))

    def test_cmp_produces_bool(self):
        text = "\n".join([
            "CONST_INT 1",  # 0
            "CONST_INT 2",  # 1
            "CMP",          # 2 -> bool
            "JZ 5",         # 3
            "HALT",         # 4
            "HALT",         # 5
        ])
        report = verify(asm(text))
        self.assertTrue(all(b.reachable for b in report.blocks))


class TestJoin(unittest.TestCase):
    def test_join_height_mismatch(self):
        text = "\n".join([
            "CONST_BOOL true",  # 0
            "JZ 5",             # 1
            "CONST_INT 7",      # 2
            "CONST_INT 8",      # 3
            "JMP 6",            # 4
            "CONST_INT 9",      # 5
            "HALT",             # 6
        ])
        with self.assertRaises(JoinError) as ctx:
            verify(asm(text))
        self.assertEqual(ctx.exception.pc, 6)
        self.assertEqual(len(ctx.exception.expected), 1)
        self.assertEqual(len(ctx.exception.actual), 2)

    def test_join_type_mismatch(self):
        text = "\n".join([
            "CONST_BOOL true",  # 0
            "JZ 4",             # 1
            "CONST_INT 7",      # 2
            "JMP 5",            # 3
            "CONST_BOOL false", # 4
            "HALT",             # 5
        ])
        with self.assertRaises(JoinError):
            verify(asm(text))

    def test_join_consistent_ok(self):
        text = "\n".join([
            "CONST_BOOL true",  # 0
            "JZ 4",             # 1
            "CONST_INT 7",      # 2
            "JMP 5",            # 3
            "CONST_INT 9",      # 4
            "HALT",             # 5
        ])
        report = verify(asm(text))
        self.assertEqual(report.warnings, [])

    def test_loop_ok(self):
        text = "\n".join([
            "CONST_INT 0",      # 0
            "CONST_BOOL true",  # 1
            "JZ 0",             # 2 back-edge carries [int], entry is []
            "HALT",             # 3
        ])
        with self.assertRaises(JoinError):
            verify(asm(text))

    def test_loop_consistent(self):
        text = "\n".join([
            "CONST_BOOL true",  # 0
            "NOT",              # 1
            "JZ 0",             # 2 (stack [] at 0 both times)
            "HALT",             # 3
        ])
        report = verify(asm(text))
        self.assertEqual(report.warnings, [])


class TestDeadCode(unittest.TestCase):
    def test_dead_type_fault_is_warning_only(self):
        text = "\n".join([
            "HALT",         # 0
            "CONST_INT 1",  # 1 (dead)
            "NOT",          # 2 (dead, expects bool)
            "HALT",         # 3 (dead)
        ])
        report = verify(asm(text))
        self.assertEqual(len(report.warnings), 1)
        self.assertEqual(report.warnings[0].kind, "DeadType")
        self.assertEqual(report.warnings[0].pc, 2)
        self.assertFalse(report.blocks[1].reachable)
        self.assertIsNone(report.blocks[1].entry_stack)

    def test_dead_underflow_is_warning_only(self):
        text = "\n".join(["HALT", "ADD", "HALT"])
        report = verify(asm(text))
        self.assertEqual(len(report.warnings), 2)  # both pops underflow
        self.assertTrue(all("underflow" in w.message for w in report.warnings))

    def test_dead_bad_jump_still_error(self):
        with self.assertRaises(VerifyError):
            verify(asm("HALT\nJMP 99\nHALT"))

    def test_dead_code_does_not_join(self):
        # Dead block pushes an int then falls into a reachable block:
        # must not cause a JoinError.
        text = "\n".join([
            "JMP 3",        # 0
            "CONST_INT 1",  # 1 (dead)
            "HALT",         # 2 (dead)
            "HALT",         # 3
        ])
        report = verify(asm(text))
        self.assertEqual(report.warnings, [])


if __name__ == "__main__":
    unittest.main()
