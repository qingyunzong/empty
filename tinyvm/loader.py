"""Bytecode container format: parsing, serialization and verification.

File layout (all integers big-endian)::

    magic   : 4 bytes  b"TVM1"
    version : u8       (must be 1)
    nconsts : u16
    consts  : nconsts * i64
    codelen : u32
    code    : codelen bytes of instructions

Load-time verification rejects (with VMError, CLI exit code 6):
  * wrong magic or unsupported version
  * truncated headers / constant pool / code section
  * unknown opcodes or truncated instructions
  * CONST operands outside the constant pool
  * LOAD/STORE local indices >= MAX_LOCALS
  * jump/call targets that are not on an instruction boundary
    or that exceed code_end
"""

import struct
from dataclasses import dataclass

from .errors import VMError
from .isa import JUMP_OPS, MAX_LOCALS, decode

MAGIC = b"TVM1"
VERSION = 1


@dataclass(frozen=True)
class Program:
    consts: tuple
    code: bytes
    boundaries: frozenset


def dump_program(consts, code):
    """Serialize a constant pool and code bytes into container format."""
    out = bytearray()
    out += MAGIC
    out += struct.pack(">B", VERSION)
    out += struct.pack(">H", len(consts))
    for value in consts:
        out += struct.pack(">q", value)
    out += struct.pack(">I", len(code))
    out += bytes(code)
    return bytes(out)


def _verify(consts, code):
    """Decode the whole code section and validate every instruction.

    Returns the frozenset of valid instruction-start offsets.
    """
    boundaries = set()
    pc = 0
    while pc < len(code):
        boundaries.add(pc)
        name, operand, size = decode(code, pc)
        if name == "CONST" and operand >= len(consts):
            raise VMError(
                f"CONST index {operand} out of range "
                f"(pool size {len(consts)}) at offset {pc}"
            )
        if name in ("LOAD", "STORE") and operand >= MAX_LOCALS:
            raise VMError(
                f"local index {operand} out of range "
                f"(max {MAX_LOCALS - 1}) at offset {pc}"
            )
        pc += size
    # code_end itself is a legal jump target (falls off -> runtime fault),
    # anything past it is not.
    boundaries.add(len(code))
    for at in sorted(boundaries):
        if at >= len(code):
            continue
        name, operand, _ = decode(code, at)
        if name in JUMP_OPS:
            if operand not in boundaries:
                raise VMError(
                    f"{name} target {operand} at offset {at} is not on an "
                    f"instruction boundary or exceeds code end {len(code)}"
                )
    return frozenset(boundaries)


def load(data):
    """Parse and verify a bytecode container. Raises VMError on any defect."""
    if len(data) < 4:
        raise VMError("file too short for magic")
    if data[:4] != MAGIC:
        raise VMError(f"bad magic {data[:4]!r}, expected {MAGIC!r}")
    if len(data) < 5:
        raise VMError("file too short for version")
    version = data[4]
    if version != VERSION:
        raise VMError(f"unsupported version {version}, expected {VERSION}")
    if len(data) < 7:
        raise VMError("file too short for constant pool header")
    (nconsts,) = struct.unpack_from(">H", data, 5)
    offset = 7
    if len(data) < offset + 8 * nconsts:
        raise VMError("truncated constant pool")
    consts = []
    for _ in range(nconsts):
        (value,) = struct.unpack_from(">q", data, offset)
        consts.append(value)
        offset += 8
    if len(data) < offset + 4:
        raise VMError("file too short for code length")
    (codelen,) = struct.unpack_from(">I", data, offset)
    offset += 4
    if len(data) < offset + codelen:
        raise VMError("truncated code section")
    code = data[offset : offset + codelen]
    if len(data) > offset + codelen:
        raise VMError("trailing bytes after code section")
    boundaries = _verify(consts, code)
    return Program(tuple(consts), bytes(code), boundaries)
