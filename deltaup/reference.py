"""Independent in-memory interpreter for instruction lists.

Used to cross-check the streaming applier on short outputs.  COPY_OUT is
implemented literally byte by byte, so overlapping copies replicate the
already-produced prefix exactly as specified.
"""

from .errors import CopyBaseOutOfRangeError, CopyOutUngeneratedError


def interpret(baseline, instrs):
    out = bytearray()
    for ins in instrs:
        op = ins[0]
        if op == "add":
            out += ins[1]
        elif op == "copy_base":
            _, offset, length = ins
            if offset + length > len(baseline):
                raise CopyBaseOutOfRangeError(
                    f"COPY_BASE [{offset}, {offset + length}) beyond baseline"
                )
            out += baseline[offset : offset + length]
        elif op == "copy_out":
            _, offset, length = ins
            if length and offset >= len(out):
                raise CopyOutUngeneratedError(
                    f"COPY_OUT from {offset} with {len(out)} bytes generated"
                )
            for i in range(length):
                out.append(out[offset + i])
        else:
            raise ValueError(f"unknown instruction {op!r}")
    return bytes(out)
