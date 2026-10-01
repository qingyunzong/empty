"""Independent in-memory interpreter for update streams.

This is a deliberately separate, straightforward implementation used by the
test suite as an oracle for the windowed, checkpointed applier.  It is only
suitable for short outputs (everything is held in memory).
"""

import hashlib

from . import varint
from .decoder import (MAGIC, OP_ADD, OP_COPY_BASE, OP_COPY_OUT, OP_END_BLOCK)
from .errors import (BadMagicError, BaselineRangeError,
                     BlockLengthExceededError, BlockLengthMismatchError,
                     CopyOutOfRangeError, FingerprintMismatchError,
                     HashMismatchError, TrailingDataError,
                     UnknownOpcodeError)


def _read_varint(stream, pos):
    got = varint.decode(stream, pos)
    if got is None:
        raise TrailingDataError("stream ends inside a varint")
    return got


def _read_bytes(stream, pos, count):
    if pos + count > len(stream):
        raise TrailingDataError("stream ends inside a fixed field")
    return stream[pos:pos + count], pos + count


def interpret(baseline: bytes, stream: bytes) -> bytes:
    pos = 0
    magic, pos = _read_bytes(stream, pos, len(MAGIC))
    if magic != MAGIC:
        raise BadMagicError(f"bad magic {magic!r}")
    fingerprint, pos = _read_bytes(stream, pos, 32)
    if fingerprint != hashlib.sha256(baseline).digest():
        raise FingerprintMismatchError("stream is for a different baseline")
    num_blocks, pos = _read_varint(stream, pos)

    out = bytearray()
    for _ in range(num_blocks):
        out_len, pos = _read_varint(stream, pos)
        block_hash, pos = _read_bytes(stream, pos, 32)
        block_start = len(out)
        while True:
            op, pos = _read_bytes(stream, pos, 1)
            op = op[0]
            if op == OP_END_BLOCK:
                break
            produced = len(out) - block_start
            if op == OP_ADD:
                length, pos = _read_varint(stream, pos)
                if length > out_len - produced:
                    raise BlockLengthExceededError("ADD exceeds block length")
                data, pos = _read_bytes(stream, pos, length)
                out += data
            elif op == OP_COPY_BASE:
                offset, pos = _read_varint(stream, pos)
                length, pos = _read_varint(stream, pos)
                if length > out_len - produced:
                    raise BlockLengthExceededError(
                        "COPY_BASE exceeds block length")
                if offset + length > len(baseline):
                    raise BaselineRangeError("COPY_BASE outside baseline")
                out += baseline[offset:offset + length]
            elif op == OP_COPY_OUT:
                distance, pos = _read_varint(stream, pos)
                length, pos = _read_varint(stream, pos)
                if length > out_len - produced:
                    raise BlockLengthExceededError(
                        "COPY_OUT exceeds block length")
                if distance < 1 or distance > len(out):
                    raise CopyOutOfRangeError(
                        "COPY_OUT references ungenerated output")
                for _ in range(length):  # byte-by-byte: overlap replicates
                    out.append(out[len(out) - distance])
            else:
                raise UnknownOpcodeError(f"unknown opcode 0x{op:02x}")
        block = bytes(out[block_start:])
        if len(block) != out_len:
            raise BlockLengthMismatchError(
                f"block produced {len(block)}, declared {out_len}")
        if hashlib.sha256(block).digest() != block_hash:
            raise HashMismatchError("block hash mismatch")

    final_hash, pos = _read_bytes(stream, pos, 32)
    if hashlib.sha256(bytes(out)).digest() != final_hash:
        raise HashMismatchError("final total hash mismatch")
    if pos != len(stream):
        raise TrailingDataError("bytes after end of update stream")
    return bytes(out)
