"""Simple offline encoder: baseline file + target file -> update stream.

This is a development/distribution-side tool and may hold the inputs in
memory; the 64 KiB window constraint applies to the *applier*, which is the
component that runs where resources are limited.
"""

import difflib
import hashlib

from . import varint
from .decoder import MAGIC, OP_ADD, OP_COPY_BASE, OP_END_BLOCK


def encode_stream(baseline: bytes, target: bytes,
                  block_size: int = 1 << 20) -> bytes:
    matcher = difflib.SequenceMatcher(a=baseline, b=target, autojunk=False)
    pieces = []  # ("add", bytes) | ("copy_base", offset, length)
    for tag, a0, a1, b0, b1 in matcher.get_opcodes():
        if tag == "equal":
            pieces.append(("copy_base", a0, a1 - a0))
        elif tag in ("replace", "insert"):
            pieces.append(("add", target[b0:b1]))
        # "delete" produces no output

    # Split pieces into blocks of at most block_size output bytes.
    blocks = []
    current = []
    current_len = 0
    for piece in pieces:
        remaining = piece
        while True:
            plen = len(remaining[1]) if remaining[0] == "add" else remaining[2]
            room = block_size - current_len
            if plen <= room:
                if plen:
                    current.append(remaining)
                    current_len += plen
                break
            if room > 0:
                head, tail = _split_piece(remaining, room)
                current.append(head)
                remaining = tail
            blocks.append(current)
            current = []
            current_len = 0
    if current or not blocks:
        blocks.append(current)

    stream = bytearray(MAGIC)
    stream += hashlib.sha256(baseline).digest()
    stream += varint.encode(len(blocks))
    total = hashlib.sha256()
    for block in blocks:
        block_out = bytearray()
        body = bytearray()
        for piece in block:
            if piece[0] == "add":
                body += bytes((OP_ADD,)) + varint.encode(len(piece[1])) + piece[1]
                block_out += piece[1]
            else:
                _, offset, length = piece
                body += (bytes((OP_COPY_BASE,)) + varint.encode(offset)
                         + varint.encode(length))
                block_out += baseline[offset:offset + length]
        body += bytes((OP_END_BLOCK,))
        stream += varint.encode(len(block_out))
        stream += hashlib.sha256(bytes(block_out)).digest()
        stream += body
        total.update(block_out)
    stream += total.digest()
    return bytes(stream)


def _split_piece(piece, size):
    if piece[0] == "add":
        return ("add", piece[1][:size]), ("add", piece[1][size:])
    _, offset, length = piece
    return (("copy_base", offset, size),
            ("copy_base", offset + size, length - size))


def encode_file(baseline_path, target_path, out_path,
                block_size: int = 1 << 20):
    with open(baseline_path, "rb") as fh:
        baseline = fh.read()
    with open(target_path, "rb") as fh:
        target = fh.read()
    stream = encode_stream(baseline, target, block_size)
    with open(out_path, "wb") as fh:
        fh.write(stream)
    return len(stream)
