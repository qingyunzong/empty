"""Bounded canonical varint (unsigned LEB128, at most 9 bytes / 63 bits).

Canonical means the encoding is minimal: no trailing zero continuation
byte.  ``decode_prefix`` never raises for an incomplete buffer; it returns
``None`` so the caller knows at least one more byte is required.
"""

from .errors import LengthOverflowError

MAX_BYTES = 9
MAX_VALUE = (1 << 63) - 1


def encode(value):
    if not 0 <= value <= MAX_VALUE:
        raise LengthOverflowError(f"varint value out of range: {value}")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def decode_prefix(buf, start=0):
    """Decode one varint from ``buf[start:]``.

    Returns ``(value, nbytes)`` on success, ``None`` if the buffer holds
    only a strict prefix of a valid encoding (need at least one more
    byte).  Raises :class:`LengthOverflowError` for encodings longer than
    9 bytes or non-canonical (padded) encodings.
    """
    result = 0
    shift = 0
    idx = 0
    pos = start
    end = len(buf)
    while pos < end:
        byte = buf[pos]
        if idx == MAX_BYTES:
            raise LengthOverflowError("varint exceeds 9 bytes")
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            if idx > 0 and byte == 0:
                raise LengthOverflowError("non-canonical varint encoding")
            return result, idx + 1
        shift += 7
        idx += 1
        pos += 1
    return None
