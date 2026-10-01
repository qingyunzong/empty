"""Program representation and binary (de)serialisation.

File layout (all integers little-endian)::

    "PBC1"                     magic
    u16  nconsts
    i64  const[nconsts]        constant pool
    u32  ncode
    ins  code[ncode]           3 bytes each: u8 opcode, u16 operand
    ["MAP1" u32 npairs (u32 old_pc, u32 new_pc) * npairs]   optional

The optional MAP section records the old_pc -> new_pc mapping produced by
the optimiser.  Readers that do not care about it may stop after the code
section.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

from . import isa

MAGIC = b"PBC1"
MAP_MAGIC = b"MAP1"


class FormatError(Exception):
    """Raised when a byte stream is not a valid peepbc program."""


@dataclass(frozen=True)
class Ins:
    op: int
    arg: int = 0

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        name = isa.NAMES.get(self.op, f"OP{self.op:#x}")
        return f"{name} {self.arg}" if self.op in isa.HAS_ARG else name


@dataclass
class Program:
    consts: list[int] = field(default_factory=list)
    code: list[Ins] = field(default_factory=list)

    def to_bytes(self, mapping: dict[int, int] | None = None) -> bytes:
        out = bytearray()
        out += MAGIC
        out += struct.pack("<H", len(self.consts))
        for value in self.consts:
            out += struct.pack("<q", value)
        out += struct.pack("<I", len(self.code))
        for ins in self.code:
            if not 0 <= ins.arg <= 0xFFFF:
                raise FormatError(f"operand {ins.arg} does not fit in u16")
            out += struct.pack("<BH", ins.op, ins.arg)
        if mapping is not None:
            out += MAP_MAGIC
            out += struct.pack("<I", len(mapping))
            for old_pc in sorted(mapping):
                out += struct.pack("<II", old_pc, mapping[old_pc])
        return bytes(out)

    @classmethod
    def from_bytes(cls, data: bytes) -> tuple["Program", dict[int, int] | None]:
        if len(data) < 6 or data[:4] != MAGIC:
            raise FormatError("bad magic (not a peepbc program)")
        pos = 4
        (nconsts,) = struct.unpack_from("<H", data, pos)
        pos += 2
        need = nconsts * 8
        if len(data) < pos + need + 4:
            raise FormatError("truncated constant pool")
        consts = list(struct.unpack_from(f"<{nconsts}q", data, pos))
        pos += need
        (ncode,) = struct.unpack_from("<I", data, pos)
        pos += 4
        if len(data) < pos + ncode * 3:
            raise FormatError("truncated code section")
        code = []
        for _ in range(ncode):
            op, arg = struct.unpack_from("<BH", data, pos)
            pos += 3
            if op not in isa.NAMES:
                raise FormatError(f"unknown opcode {op:#x}")
            code.append(Ins(op, arg))
        mapping = None
        if len(data) > pos:
            if data[pos:pos + 4] != MAP_MAGIC:
                raise FormatError("trailing garbage after code section")
            pos += 4
            (npairs,) = struct.unpack_from("<I", data, pos)
            pos += 4
            if len(data) != pos + npairs * 8:
                raise FormatError("truncated map section")
            mapping = {}
            for _ in range(npairs):
                old_pc, new_pc = struct.unpack_from("<II", data, pos)
                pos += 8
                mapping[old_pc] = new_pc
        return cls(consts, code), mapping

    def disassemble(self) -> str:
        labels = {ins.arg for ins in self.code if ins.op in isa.JUMPS}
        lines = [f"; {len(self.consts)} consts: {self.consts}"]
        for pc, ins in enumerate(self.code):
            mark = f"L{pc}: " if pc in labels else ""
            lines.append(f"{pc:4d}: {mark}{ins}")
        return "\n".join(lines)
