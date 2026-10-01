"""Instruction set definition and encode/decode helpers.

Binary instruction encoding (big-endian):
    <opcode:u8> [operand:u16]

Instructions with a u16 operand: CONST, LOAD, STORE, JMP, JZ, JNZ, CALL.
All others are a single opcode byte.
"""

import struct

from .errors import VMError

OPCODES = {
    "CONST": 0x01,
    "LOAD": 0x02,
    "STORE": 0x03,
    "ADD": 0x10,
    "SUB": 0x11,
    "MUL": 0x12,
    "DIV": 0x13,
    "MOD": 0x14,
    "JMP": 0x20,
    "JZ": 0x21,
    "JNZ": 0x22,
    "CALL": 0x30,
    "RET": 0x31,
    "HALT": 0xFF,
}

NAMES = {code: name for name, code in OPCODES.items()}

OPERAND_OPS = frozenset({"CONST", "LOAD", "STORE", "JMP", "JZ", "JNZ", "CALL"})
JUMP_OPS = frozenset({"JMP", "JZ", "JNZ", "CALL"})

MAX_LOCALS = 256


def instr_size(name):
    return 3 if name in OPERAND_OPS else 1


def encode(name, operand=None):
    """Encode one instruction to bytes."""
    if name not in OPCODES:
        raise ValueError(f"unknown instruction: {name!r}")
    opcode = OPCODES[name]
    if name in OPERAND_OPS:
        if operand is None:
            raise ValueError(f"{name} requires an operand")
        if not 0 <= operand <= 0xFFFF:
            raise ValueError(f"operand out of u16 range: {operand}")
        return struct.pack(">BH", opcode, operand)
    if operand is not None:
        raise ValueError(f"{name} takes no operand")
    return bytes([opcode])


def decode(code, pc):
    """Decode the instruction at ``pc`` in ``code``.

    Returns ``(name, operand, size)``; ``operand`` is None for
    operand-less instructions. Raises VMError on truncation or an
    unknown opcode.
    """
    if pc >= len(code):
        raise VMError(f"instruction pointer {pc} beyond code end {len(code)}")
    opcode = code[pc]
    name = NAMES.get(opcode)
    if name is None:
        raise VMError(f"unknown opcode 0x{opcode:02x} at offset {pc}")
    if name in OPERAND_OPS:
        if pc + 3 > len(code):
            raise VMError(f"truncated operand for {name} at offset {pc}")
        (operand,) = struct.unpack_from(">H", code, pc + 1)
        return name, operand, 3
    return name, None, 1
