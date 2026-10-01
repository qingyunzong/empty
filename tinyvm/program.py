"""Bytecode container format, serialization and load-time verification.

Binary layout (all integers little-endian)::

    magic    4 bytes   b"TVM1"
    version  u8        currently 1
    nlocals  u16       number of locals per call frame
    nconsts  u16       constant pool size
    consts   nconsts * i64
    code_len u32       byte length of the code section
    code     code_len bytes

Verification performed by :func:`loads` (any failure raises VMError):

- magic and version match
- the file is exactly as long as the layout requires
- every instruction decodes cleanly and the code section ends on an
  instruction boundary
- CONST operands are valid constant pool indices
- LOAD/STORE operands are valid local indices
- JMP/JZ/JNZ/CALL targets land on an instruction boundary and do not
  exceed code_end
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from . import isa
from .errors import VMError

MAGIC = b"TVM1"
VERSION = 1

_HEADER = struct.Struct("<4sBHH")
_CONST = struct.Struct("<q")
_CODE_LEN = struct.Struct("<I")


@dataclass
class Program:
    consts: list = field(default_factory=list)
    nlocals: int = 0
    code: bytes = b""

    @property
    def code_end(self):
        return len(self.code)

    def serialize(self) -> bytes:
        out = bytearray()
        out += _HEADER.pack(MAGIC, VERSION, self.nlocals, len(self.consts))
        for value in self.consts:
            out += _CONST.pack(value)
        out += _CODE_LEN.pack(len(self.code))
        out += self.code
        return bytes(out)


def loads(data: bytes) -> Program:
    """Parse and verify a bytecode image, raising VMError on any defect."""
    if len(data) < _HEADER.size:
        raise VMError("file too short for header (%d bytes)" % len(data))
    magic, version, nlocals, nconsts = _HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise VMError("bad magic %r (expected %r)" % (magic, MAGIC))
    if version != VERSION:
        raise VMError("unsupported version %d (expected %d)" % (version, VERSION))

    offset = _HEADER.size
    consts_end = offset + nconsts * _CONST.size
    if len(data) < consts_end + _CODE_LEN.size:
        raise VMError("file truncated in constant pool")
    consts = [
        _CONST.unpack_from(data, offset + i * _CONST.size)[0] for i in range(nconsts)
    ]
    (code_len,) = _CODE_LEN.unpack_from(data, consts_end)
    code_start = consts_end + _CODE_LEN.size
    if len(data) < code_start + code_len:
        raise VMError(
            "file truncated: code section is %d bytes, need %d"
            % (len(data) - code_start, code_len)
        )
    if len(data) > code_start + code_len:
        raise VMError("trailing bytes after code section")
    code = data[code_start : code_start + code_len]

    program = Program(consts=consts, nlocals=nlocals, code=code)
    verify(program)
    return program


def verify(program: Program) -> None:
    """Verify instruction decoding and operand sanity."""
    code = program.code
    code_end = len(code)
    boundaries = set()
    instructions = []  # (pc, opcode, operand)

    pc = 0
    while pc < code_end:
        opcode = code[pc]
        if opcode not in isa.NAMES:
            raise VMError("unknown opcode 0x%02x at pc=%d" % (opcode, pc))
        size = isa.instruction_size(opcode)
        if pc + size > code_end:
            raise VMError("truncated instruction at pc=%d" % pc)
        _, operand, _ = isa.decode(code, pc)
        boundaries.add(pc)
        instructions.append((pc, opcode, operand))
        pc += size

    for pc, opcode, operand in instructions:
        name = isa.NAMES[opcode]
        if opcode == isa.OPCODES["CONST"]:
            if operand >= len(program.consts):
                raise VMError(
                    "CONST index %d out of range (pool size %d) at pc=%d"
                    % (operand, len(program.consts), pc)
                )
        elif opcode in (isa.OPCODES["LOAD"], isa.OPCODES["STORE"]):
            if operand >= program.nlocals:
                raise VMError(
                    "%s local index %d out of range (nlocals %d) at pc=%d"
                    % (name, operand, program.nlocals, pc)
                )
        elif opcode in isa.JUMP_OPS:
            if operand > code_end:
                raise VMError(
                    "%s target %d beyond code_end %d at pc=%d"
                    % (name, operand, code_end, pc)
                )
            if operand != code_end and operand not in boundaries:
                raise VMError(
                    "%s target %d is not an instruction boundary (pc=%d)"
                    % (name, operand, pc)
                )
