"""Load-time verification tests (acceptance item B included)."""

import struct
import unittest

from tinyvm import isa
from tinyvm.errors import VMError
from tinyvm.program import MAGIC, VERSION, Program, loads

OP = isa.OPCODES


def instr(name, operand=None):
    opcode = OP[name]
    out = bytearray([opcode])
    if opcode in isa.OPERAND_OPS:
        out += struct.pack("<H", operand)
    return bytes(out)


def make_program(consts=(), nlocals=0, code=b""):
    return Program(consts=list(consts), nlocals=nlocals, code=code)


class TestValidPrograms(unittest.TestCase):
    def test_roundtrip_minimal(self):
        prog = make_program(consts=[42], code=instr("CONST", 0) + instr("HALT"))
        loaded = loads(prog.serialize())
        self.assertEqual(loaded.consts, [42])
        self.assertEqual(loaded.code, prog.code)
        self.assertEqual(loaded.nlocals, 0)

    def test_jump_to_code_end_is_allowed_by_verifier(self):
        code = instr("JMP", 3) + instr("HALT")
        loads(make_program(code=code).serialize())  # must not raise

    def test_jump_to_self_is_allowed(self):
        loads(make_program(code=instr("JMP", 0)).serialize())


class TestBadFiles(unittest.TestCase):
    def test_bad_magic(self):
        prog = make_program(code=instr("HALT"))
        blob = b"XXXX" + prog.serialize()[4:]
        with self.assertRaises(VMError):
            loads(blob)

    def test_bad_version(self):
        prog = make_program(code=instr("HALT"))
        blob = bytearray(prog.serialize())
        blob[4] = VERSION + 1
        with self.assertRaises(VMError):
            loads(bytes(blob))

    def test_truncated_file(self):
        blob = make_program(consts=[1, 2, 3], code=instr("HALT")).serialize()
        with self.assertRaises(VMError):
            loads(blob[:-2])

    def test_trailing_bytes(self):
        blob = make_program(code=instr("HALT")).serialize() + b"\x00"
        with self.assertRaises(VMError):
            loads(blob)

    def test_unknown_opcode(self):
        with self.assertRaises(VMError):
            loads(make_program(code=b"\xee").serialize())

    def test_truncated_instruction(self):
        code = bytes([OP["CONST"], 0])  # operand cut short
        with self.assertRaises(VMError):
            loads(make_program(consts=[0], code=code).serialize())

    def test_const_pool_index_out_of_range(self):
        code = instr("CONST", 1) + instr("HALT")
        with self.assertRaises(VMError):
            loads(make_program(consts=[7], code=code).serialize())

    def test_local_index_out_of_range(self):
        code = instr("LOAD", 2) + instr("HALT")
        with self.assertRaises(VMError):
            loads(make_program(nlocals=2, code=code).serialize())

    def test_store_local_index_out_of_range(self):
        code = instr("STORE", 1) + instr("HALT")
        with self.assertRaises(VMError):
            loads(make_program(nlocals=1, code=code).serialize())

    def test_jump_into_middle_of_instruction(self):
        # Acceptance B: target 1 lands inside the 3-byte CONST at pc=0.
        code = instr("CONST", 0) + instr("JMP", 1) + instr("HALT")
        with self.assertRaises(VMError) as ctx:
            loads(make_program(consts=[9], code=code).serialize())
        self.assertIn("boundary", str(ctx.exception))

    def test_jump_beyond_code_end(self):
        code = instr("JMP", 100) + instr("HALT")
        with self.assertRaises(VMError) as ctx:
            loads(make_program(code=code).serialize())
        self.assertIn("beyond code_end", str(ctx.exception))

    def test_call_target_must_be_boundary(self):
        code = instr("CONST", 0) + instr("CALL", 2) + instr("HALT")
        with self.assertRaises(VMError):
            loads(make_program(consts=[9], code=code).serialize())

    def test_jz_jnz_targets_validated(self):
        for name in ("JZ", "JNZ"):
            code = instr("CONST", 0) + instr(name, 300) + instr("HALT")
            with self.assertRaises(VMError):
                loads(make_program(consts=[9], code=code).serialize())


if __name__ == "__main__":
    unittest.main()
