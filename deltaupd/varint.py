"""Bounded canonical unsigned varint (LEB128).

Bounds: values are limited to 63 bits, so an encoding is at most 9 bytes.
Canonical: the encoding must be minimal -- a multi-byte encoding whose final
byte is zero is rejected.  Anything needing more than 9 bytes raises
LengthOverflowError, which is kept strictly distinct from range errors on
copy instructions.
"""

from .errors import LengthOverflowError, NonCanonicalVarintError

MAX_VALUE = (1 << 63) - 1
MAX_BYTES = 9


def encode(value: int) -> bytes:
    if not 0 <= value <= MAX_VALUE:
        raise ValueError(f"varint value out of range: {value!r}")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decode(buf, pos: int = 0):
    """Decode one varint from ``buf`` starting at ``pos``.

    Returns ``(value, next_pos)``, or ``None`` if the buffer does not yet
    hold a complete varint.  Raises on overflow or non-canonical encodings.
    """
    result = 0
    shift = 0
    i = pos
    while True:
        if i >= len(buf):
            return None
        if i - pos + 1 > MAX_BYTES:
            raise LengthOverflowError("varint exceeds 9 bytes (63-bit bound)")
        byte = buf[i]
        result |= (byte & 0x7F) << shift
        i += 1
        if not byte & 0x80:
            break
        shift += 7
    if i - pos > 1 and buf[i - 1] == 0:
        raise NonCanonicalVarintError("varint is not minimally encoded")
    return result, i
