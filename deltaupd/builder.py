"""Helpers to construct well-formed update streams (used by tests/encoder)."""

import hashlib

from . import varint
from .decoder import MAGIC, OP_ADD, OP_COPY_BASE, OP_COPY_OUT, OP_END_BLOCK
from .errors import BaselineRangeError, CopyOutOfRangeError


def build_update(baseline: bytes, blocks, fingerprint: bytes = None) -> bytes:
    """Build an update stream from instruction tuples.

    ``blocks`` is a list of blocks; each block is a list of instructions:
    ``("add", data)``, ``("copy_base", offset, length)`` or
    ``("copy_out", distance, length)``.  Block lengths/hashes and the final
    hash are computed by executing the instructions in memory.
    """
    if fingerprint is None:
        fingerprint = hashlib.sha256(baseline).digest()
    out = bytearray()
    stream = bytearray(MAGIC)
    stream += fingerprint
    stream += varint.encode(len(blocks))
    for block in blocks:
        body = bytearray()
        block_out = bytearray()
        for ins in block:
            if ins[0] == "add":
                data = bytes(ins[1])
                body += bytes((OP_ADD,)) + varint.encode(len(data)) + data
                block_out += data
            elif ins[0] == "copy_base":
                _, offset, length = ins
                if offset + length > len(baseline):
                    raise BaselineRangeError("COPY_BASE outside baseline")
                body += (bytes((OP_COPY_BASE,)) + varint.encode(offset)
                         + varint.encode(length))
                block_out += baseline[offset:offset + length]
            elif ins[0] == "copy_out":
                _, distance, length = ins
                produced = out + block_out
                if distance < 1 or distance > len(produced):
                    raise CopyOutOfRangeError("COPY_OUT of ungenerated output")
                body += (bytes((OP_COPY_OUT,)) + varint.encode(distance)
                         + varint.encode(length))
                for _ in range(length):
                    block_out += produced[len(produced) - distance:
                                          len(produced) - distance + 1]
                    produced = out + block_out
            else:
                raise ValueError(f"unknown instruction {ins[0]!r}")
        body += bytes((OP_END_BLOCK,))
        stream += varint.encode(len(block_out))
        stream += hashlib.sha256(bytes(block_out)).digest()
        stream += body
        out += block_out
    stream += hashlib.sha256(bytes(out)).digest()
    return bytes(stream)
