import unittest

from typedbc import (
    JoinError,
    TypeFault,
    VerifyError,
    parse,
    verify,
)


def verify_src(src):
    return verify(parse(src))


class WellTypedTests(unittest.TestCase):
    def test_arithmetic_and_compare(self):
        result = verify_src(
            """
            CONST_INT 3
            CONST_INT 4
            ADD
            CONST_INT 7
            CMP
            NOT
            HALT
            """
        )
        entry = result.blocks[0]
        self.assertTrue(entry.reachable)
        self.assertEqual(entry.out_stack, ("bool",))
        self.assertEqual(result.warnings, [])

    def test_if_else_matching_stacks_join_ok(self):
        result = verify_src(
            """
            CONST_BOOL true
            JZ 4
            CONST_INT 1
            JMP 5
            CONST_INT 2
            HALT
            """
        )
        self.assertEqual(result.warnings, [])
        by_start = {b.start: b for b in result.blocks}
        self.assertEqual(by_start[5].in_stack, ("int",))

    def test_loop_with_stable_stack(self):
        result = verify_src(
            """
            CONST_BOOL true
            JZ 0
            HALT
            """
        )
        self.assertEqual(result.warnings, [])

    def test_run_off_end_is_implicit_halt(self):
        result = verify_src("CONST_INT 1")
        self.assertEqual(result.blocks[0].out_stack, ("int",))


class JoinErrorTests(unittest.TestCase):
    def test_if_arms_with_different_stack_heights(self):
        # Acceptance case B: the two arms of the if reach pc 6 with stacks
        # of different heights.
        with self.assertRaises(JoinError) as ctx:
            verify_src(
                """
                CONST_BOOL true
                JZ 4
                CONST_INT 1
                JMP 6
                CONST_INT 2
                CONST_INT 3
                HALT
                """
            )
        err = ctx.exception
        self.assertEqual(err.pc, 6)
        self.assertEqual(err.expected, ["int"])
        self.assertEqual(err.actual, ["int", "int"])

    def test_join_same_height_different_types(self):
        with self.assertRaises(JoinError):
            verify_src(
                """
                CONST_BOOL true
                JZ 4
                CONST_INT 1
                JMP 5
                CONST_BOOL false
                HALT
                """
            )


class TypeFaultTests(unittest.TestCase):
    def test_jz_requires_bool_on_top(self):
        # Acceptance case C.
        with self.assertRaises(TypeFault) as ctx:
            verify_src(
                """
                CONST_INT 5
                JZ 2
                HALT
                """
            )
        err = ctx.exception
        self.assertEqual(err.pc, 1)
        self.assertEqual(err.expected, "bool")
        self.assertEqual(err.actual, "int")
        self.assertEqual(err.stack, ["int"])

    def test_add_requires_two_ints(self):
        with self.assertRaises(TypeFault) as ctx:
            verify_src(
                """
                CONST_INT 1
                CONST_BOOL true
                ADD
                HALT
                """
            )
        err = ctx.exception
        self.assertEqual(err.pc, 2)
        self.assertEqual(err.expected, "int")
        self.assertEqual(err.actual, "bool")
        self.assertEqual(err.stack, ["int", "bool"])

    def test_not_requires_bool(self):
        with self.assertRaises(TypeFault):
            verify_src(
                """
                CONST_INT 1
                NOT
                HALT
                """
            )

    def test_cmp_produces_bool_consumed_by_jz(self):
        result = verify_src(
            """
            CONST_INT 1
            CONST_INT 2
            CMP
            JZ 5
            HALT
            HALT
            """
        )
        self.assertEqual(result.warnings, [])


class VerifyErrorTests(unittest.TestCase):
    def test_bad_jump_target(self):
        with self.assertRaises(VerifyError):
            verify_src(
                """
                CONST_BOOL true
                JZ 99
                HALT
                """
            )

    def test_negative_jump_target(self):
        with self.assertRaises(VerifyError):
            verify_src("JMP -1")

    def test_stack_underflow(self):
        with self.assertRaises(VerifyError):
            verify_src("ADD")

    def test_stack_height_overflow(self):
        src = "\n".join(["CONST_INT 1"] * 33)
        with self.assertRaises(VerifyError):
            verify_src(src)
        # 32 pushes are fine.
        ok = "\n".join(["CONST_INT 1"] * 32 + ["HALT"])
        self.assertEqual(verify_src(ok).warnings, [])

    def test_empty_program(self):
        with self.assertRaises(VerifyError):
            verify_src("")

    def test_dead_code_still_structurally_checked(self):
        with self.assertRaises(VerifyError):
            verify_src(
                """
                HALT
                JMP 99
                """
            )


class DeadCodeTests(unittest.TestCase):
    DEAD_SRC = """
    CONST_BOOL true
    JZ 3
    HALT
    HALT
    ADD
    """

    def test_dead_type_error_is_warning_only(self):
        # Acceptance case D: ADD at pc 4 is unreachable and underflows;
        # it must surface as a DeadType warning, not an error.
        result = verify_src(self.DEAD_SRC)
        self.assertEqual(len(result.warnings), 1)
        warning = result.warnings[0]
        self.assertEqual(warning.pc, 4)
        self.assertIn("underflow", warning.message)

    def test_dead_block_marked_unreachable(self):
        result = verify_src(self.DEAD_SRC)
        by_start = {b.start: b for b in result.blocks}
        self.assertFalse(by_start[4].reachable)
        self.assertIsNone(by_start[4].in_stack)


if __name__ == "__main__":
    unittest.main()
