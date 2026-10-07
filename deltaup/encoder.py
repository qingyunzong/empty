"""Delta encoder: builds streams in the format decoded by ``decoder``.

``encode_instructions`` serializes an explicit instruction list (used by
tests to craft precise, including malformed, streams).
``encode_delta_bytes`` / ``encode_delta`` produce a delta from baseline
and target contents with a simple greedy matcher.  ``mmap`` is used so
neither file is loaded wholesale into memory.
"""

from __future__ import annotations

import hashlib
import mmap

from .decoder import HASH_SIZE, MAGIC, OP_ADD, OP_COPY_BASE, OP_COPY_OUT
from .varint import encode as encode_varint

_MIN_MATCH = 8
_MAX_CANDIDATES = 64


def instruction_output_length(ins):
    return len(ins[1]) if ins[0] == "add" else ins[2]


def instructions_to_bytes(instrs):
    out = bytearray()
    for ins in instrs:
        op = ins[0]
        if op == "add":
            out.append(OP_ADD)
            out += encode_varint(len(ins[1]))
            out += ins[1]
        elif op == "copy_base":
            out.append(OP_COPY_BASE)
            out += encode_varint(ins[1])
            out += encode_varint(ins[2])
        elif op == "copy_out":
            out.append(OP_COPY_OUT)
            out += encode_varint(ins[1])
            out += encode_varint(ins[2])
        else:
            raise ValueError(f"unknown instruction {op!r}")
    return bytes(out)


def chunk_instructions(instrs, block_size):
    """Group instructions into blocks of at most ``block_size`` output bytes."""
    split = []
    for ins in instrs:
        if ins[0] == "add" and len(ins[1]) > block_size:
            data = ins[1]
            for i in range(0, len(data), block_size):
                split.append(("add", data[i : i + block_size]))
        else:
            split.append(ins)
    blocks = []
    cur = []
    cur_out = 0
    for ins in split:
        n = instruction_output_length(ins)
        if cur and cur_out + n > block_size:
            blocks.append(cur)
            cur = []
            cur_out = 0
        cur.append(ins)
        cur_out += n
    if cur:
        blocks.append(cur)
    return blocks


def encode_instructions(baseline, target, blocks):
    """Serialize a complete delta stream from explicit instruction blocks."""
    out = bytearray(MAGIC)
    out += encode_varint(len(baseline))
    out += hashlib.sha256(bytes(baseline)).digest()
    out += encode_varint(len(blocks))
    produced = 0
    for block in blocks:
        block_out = sum(instruction_output_length(ins) for ins in block)
        block_sha = hashlib.sha256(
            bytes(target[produced : produced + block_out])
        ).digest()
        produced += block_out
        body = instructions_to_bytes(block)
        out += encode_varint(block_out)
        out += block_sha
        out += encode_varint(len(body))
        out += body
    if produced != len(target):
        raise ValueError("instructions do not reproduce the target length")
    out += encode_varint(len(target))
    out += hashlib.sha256(bytes(target)).digest()
    return bytes(out)


def _index_positions(data, key_len):
    index = {}
    limit = len(data) - key_len + 1
    for i in range(max(0, limit)):
        key = bytes(data[i : i + key_len])
        bucket = index.setdefault(key, [])
        if len(bucket) < _MAX_CANDIDATES:
            bucket.append(i)
    return index


def _greedy_match(baseline, target, min_match):
    key_len = _MIN_MATCH
    base_index = _index_positions(baseline, key_len)
    self_index = {}
    instrs = []
    pending = bytearray()
    pos = 0
    n_target = len(target)

    def register(q):
        if q + key_len <= n_target:
            bucket = self_index.setdefault(bytes(target[q : q + key_len]), [])
            bucket.append(q)
            if len(bucket) > _MAX_CANDIDATES:
                del bucket[: len(bucket) - _MAX_CANDIDATES]

    while pos < n_target:
        best_len = 0
        best_off = 0
        best_kind = None
        if pos + key_len <= n_target:
            key = bytes(target[pos : pos + key_len])
            for cand in base_index.get(key, ()):
                length = 0
                while (
                    cand + length < len(baseline)
                    and pos + length < n_target
                    and baseline[cand + length] == target[pos + length]
                ):
                    length += 1
                if length > best_len:
                    best_len, best_off, best_kind = length, cand, "base"
            for cand in self_index.get(key, ()):
                length = 0
                while (
                    pos + length < n_target
                    and target[cand + length] == target[pos + length]
                ):
                    length += 1
                if length > best_len:
                    best_len, best_off, best_kind = length, cand, "out"
        if best_kind is not None and best_len >= min_match:
            if pending:
                instrs.append(("add", bytes(pending)))
                pending = bytearray()
            if best_kind == "base":
                instrs.append(("copy_base", best_off, best_len))
            else:
                instrs.append(("copy_out", best_off, best_len))
            for q in range(pos, pos + best_len):
                register(q)
            pos += best_len
        else:
            pending.append(target[pos])
            register(pos)
            pos += 1
    if pending:
        instrs.append(("add", bytes(pending)))
    return instrs


def encode_delta_bytes(baseline, target, *, block_size=1 << 20, min_match=_MIN_MATCH):
    instrs = _greedy_match(baseline, target, min_match)
    blocks = chunk_instructions(instrs, block_size)
    return encode_instructions(baseline, target, blocks)


def encode_delta(baseline_path, target_path, out_path, *, block_size=1 << 20):
    with open(baseline_path, "rb") as fh:
        baseline = mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ)
        try:
            with open(target_path, "rb") as tfh:
                target = mmap.mmap(tfh.fileno(), 0, access=mmap.ACCESS_READ)
                try:
                    stream = encode_delta_bytes(
                        baseline, target, block_size=block_size
                    )
                finally:
                    target.close()
        finally:
            baseline.close()
    with open(out_path, "wb") as out:
        out.write(stream)
    return {"delta_bytes": len(stream)}
