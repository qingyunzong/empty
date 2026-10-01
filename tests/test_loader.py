"""Load-time verification tests (acceptance item B lives here)."""

import struct
import unittest

from tinyvm.errors import VMError
from tinyvm.isa import encode
from tinyvm.loader import MAGIC, VERSION, dump_program, load


def container(consts, code):
    return dump_program(consts, code)


class HeaderTests(unittest.TestCase):
    def test_bad_magic_rejected(self):
        data = bytearray(container([], encode("HALT")))
        data[0:4] = b"XXXX"
        with self.assertRaises(VMError):
            load(bytes(data))

    def test_bad_version_rejected(self):
        data = bytearray(container([], encode("HALT")))
        data[4] = VERSION + 1
        with self.assertRaises(VMError):
            load(bytes(data))

    def test_truncated_file_rejected(self):
        data = container([1, 2, 3], encode("HALT"))
        for cut in (0, 3, 4, 5, 6, 10, len(data) - 1):
            with self.assertRaises(VMError, msg=f"cut={cut}"):
                load(data[:cut])

    def test_trailing_bytes_rejected(self):
        data = container([], encode("HALT")) + b"\x00"
        with self.assertRaises(VMError):
            load(data)

    def test_valid_header_roundtrip(self):
        program = load(container([7, -3], encode("CONST", 1) + encode("HALT")))
        self.assertEqual(program.consts, (7, -3))
        self.assertEqual(program.code, encode("CONST", 1) + encode("HALT"))


class OperandVerificationTests(unittest.TestCase):
    def test_const_index_out_of_range(self):
        code = encode("CONST", 5) + encode("HALT")
        with self.assertRaises(VMError):
            load(container([1, 2], code))

    def test_const_index_at_boundary_ok(self):
        load(container([1, 2], encode("CONST", 1) + encode("HALT")))

    def test_local_index_out_of_range(self):
        for op in ("LOAD", "STORE"):
            code = encode(op, 256) + encode("HALT")
            with self.assertRaises(VMError, msg=op):
                load(container([], code))

    def test_local_index_max_ok(self):
        code = encode("CONST", 0) + encode("STORE", 255) + encode("HALT")
        load(container([9], code))

    def test_unknown_opcode_rejected(self):
        with self.assertRaises(VMError):
            load(container([], b"\x42"))

    def test_truncated_instruction_rejected(self):
        with self.assertRaises(VMError):
            load(container([1], encode("CONST", 0)[:2]))


class JumpVerificationTests(unittest.TestCase):
    def test_jump_into_middle_of_instruction_rejected(self):
        # CONST sits at offset 0..2, so offset 1 is mid-instruction.
        code = encode("JMP", 1) + encode("CONST", 0) + encode("HALT")
        with self.assertRaises(VMError):
            load(container([5], code))

    def test_jump_beyond_code_end_rejected(self):
        code = encode("JMP", 100) + encode("HALT")
        with self.assertRaises(VMError):
            load(container([], code))

    def test_conditional_jump_to_middle_rejected(self):
        for op in ("JZ", "JNZ"):
            code = encode(op, 2) + encode("CONST", 0) + encode("HALT")
            with self.assertRaises(VMError, msg=op):
                load(container([5], code))

    def test_call_to_middle_rejected(self):
        code = encode("CALL", 1) + encode("CONST", 0) + encode("HALT")
        with self.assertRaises(VMError):
            load(container([5], code))

    def test_jump_to_instruction_boundary_ok(self):
        # JMP 3 skips the CONST and lands exactly on HALT.
        code = encode("JMP", 3) + encode("CONST", 0) + encode("HALT")
        load(container([5], code))

    def test_jump_to_self_ok(self):
        load(container([], encode("JMP", 0)))

    def test_jump_to_code_end_ok(self):
        # code_end is a legal target; falling off is a runtime matter.
        code = encode("JMP", 3) + encode("HALT")
        load(container([], code))

    def test_boundaries_recorded(self):
        code = encode("CONST", 0) + encode("HALT")
        program = load(container([1], code))
        self.assertEqual(program.boundaries, frozenset({0, 3, 4}))


if __name__ == "__main__":
    unittest.main()
