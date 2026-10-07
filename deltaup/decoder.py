"""Incremental decoder for the delta stream format.

Stream layout::

    header  := MAGIC(8) baseline_len(varint) baseline_sha256(32) block_count(varint)
    block   := out_len(varint) block_sha256(32) instr_len(varint) instr_bytes
    instr   := 0x01 len(varint) payload                 (ADD)
             | 0x02 offset(varint) length(varint)       (COPY_BASE)
             | 0x03 offset(varint) length(varint)       (COPY_OUT)
    trailer := total_out_len(varint) total_sha256(32)

The decoder is a push state machine: ``feed`` accepts arbitrary byte
slices and returns the number of additional bytes needed to complete the
unit currently being parsed (0 once the stream is finished).  Definite
errors raise immediately.  Parsed items are delivered as ``events``:
``(stream_offset, name, args, state)`` where ``stream_offset`` is the
absolute offset just past the bytes that completed the event and
``state`` is the serializable decoder checkpoint state snapshot taken at
that exact boundary (the decoder itself may already have parsed ahead).

ADD payloads are streamed through as ``add_begin`` / ``add_data`` /
``add_end`` events so memory stays bounded regardless of payload size.
"""

from __future__ import annotations

import collections

from .errors import FormatError
from .varint import decode_prefix

MAGIC = b"DUPD0001"
OP_ADD = 0x01
OP_COPY_BASE = 0x02
OP_COPY_OUT = 0x03
HASH_SIZE = 32

_COPY_NAMES = {OP_COPY_BASE: "copy_base", OP_COPY_OUT: "copy_out"}


class Decoder:
    def __init__(self):
        self.phase = "header"  # header | block_header | instructions | trailer
        self.step = 0
        self.buffer = bytearray()
        self.consumed = 0
        self.events = collections.deque()
        self.baseline_len = None
        self.baseline_sha = None
        self.block_count = None
        self.block_index = 0
        self.instr_remaining = 0
        self._add_remaining = 0
        self._vals = None
        self.finished = False

    # ------------------------------------------------------------------ API

    def feed(self, data):
        """Consume ``data``; return bytes needed to finish the current unit."""
        if data:
            self.buffer += data
        self._parse()
        return self.needed()

    def needed(self):
        """Minimum additional bytes required to complete the current unit."""
        if self.finished:
            return 0
        if self._add_remaining:
            return self._add_remaining
        have = len(self.buffer)
        if self.phase == "header":
            if self.step == 0:
                return max(1, len(MAGIC) - have)
            if self.step == 2:
                return max(1, HASH_SIZE - have)
            return 1
        if self.phase == "block_header":
            if self.step == 1:
                return max(1, HASH_SIZE - have)
            return 1
        if self.phase == "trailer":
            if self.step == 1:
                return max(1, HASH_SIZE - have)
            return 1
        return 1

    def checkpoint_state(self):
        """Serializable decoder state, valid at instruction boundaries."""
        return {
            "phase": self.phase,
            "block_index": self.block_index,
            "instr_remaining": self.instr_remaining,
            "block_count": self.block_count,
            "baseline_len": self.baseline_len,
            "baseline_sha256": self.baseline_sha.hex()
            if self.baseline_sha is not None
            else None,
        }

    @classmethod
    def from_state(cls, state, consumed):
        obj = cls()
        obj.phase = state["phase"]
        obj.block_index = state["block_index"]
        obj.instr_remaining = state["instr_remaining"]
        obj.block_count = state["block_count"]
        obj.baseline_len = state["baseline_len"]
        sha = state["baseline_sha256"]
        obj.baseline_sha = bytes.fromhex(sha) if sha is not None else None
        obj.consumed = consumed
        return obj

    # -------------------------------------------------------------- internals

    def _take(self, n):
        del self.buffer[:n]
        self.consumed += n

    def _emit(self, name, *args):
        self.events.append(
            (self.consumed, name, args, self.checkpoint_state())
        )

    def _parse(self):
        while True:
            if self.finished:
                if self.buffer:
                    raise FormatError("trailing bytes after stream end")
                return
            if self._add_remaining:
                if not self.buffer:
                    return
                n = min(len(self.buffer), self._add_remaining)
                chunk = bytes(self.buffer[:n])
                self._take(n)
                self._add_remaining -= n
                self.instr_remaining -= n
                self._emit("add_data", chunk)
                if not self._add_remaining:
                    self._emit("add_end")
                continue
            if self.phase == "header":
                if not self._p_header():
                    return
            elif self.phase == "block_header":
                if not self._p_block_header():
                    return
            elif self.phase == "instructions":
                if not self._p_instructions():
                    return
            elif self.phase == "trailer":
                if not self._p_trailer():
                    return
            else:  # pragma: no cover - defensive
                raise FormatError(f"bad decoder phase {self.phase!r}")

    def _p_header(self):
        if self.step == 0:
            if len(self.buffer) < len(MAGIC):
                return False
            if bytes(self.buffer[: len(MAGIC)]) != MAGIC:
                raise FormatError("bad stream magic")
            self._take(len(MAGIC))
            self.step = 1
        elif self.step == 1:
            r = decode_prefix(self.buffer)
            if r is None:
                return False
            self.baseline_len = r[0]
            self._take(r[1])
            self.step = 2
        elif self.step == 2:
            if len(self.buffer) < HASH_SIZE:
                return False
            self.baseline_sha = bytes(self.buffer[:HASH_SIZE])
            self._take(HASH_SIZE)
            self.step = 3
        else:
            r = decode_prefix(self.buffer)
            if r is None:
                return False
            self.block_count = r[0]
            self._take(r[1])
            self.step = 0
            self.phase = "block_header" if self.block_count else "trailer"
            self._emit(
                "header", self.baseline_len, self.baseline_sha, self.block_count
            )
        return True

    def _p_block_header(self):
        if self.step == 0:
            r = decode_prefix(self.buffer)
            if r is None:
                return False
            self._vals = [r[0]]
            self._take(r[1])
            self.step = 1
        elif self.step == 1:
            if len(self.buffer) < HASH_SIZE:
                return False
            self._vals.append(bytes(self.buffer[:HASH_SIZE]))
            self._take(HASH_SIZE)
            self.step = 2
        else:
            r = decode_prefix(self.buffer)
            if r is None:
                return False
            out_len, sha = self._vals
            instr_len = r[0]
            self._take(r[1])
            self._vals = None
            self.step = 0
            self.instr_remaining = instr_len
            self.phase = "instructions"
            self._emit("block_header", self.block_index, out_len, sha, instr_len)
        return True

    def _p_instructions(self):
        if self.instr_remaining == 0:
            ended = self.block_index
            self.block_index += 1
            self.phase = (
                "block_header" if self.block_index < self.block_count else "trailer"
            )
            self._emit("block_end", ended)
            return True
        if not self.buffer:
            return False
        op = self.buffer[0]
        if op == OP_ADD:
            r = decode_prefix(self.buffer, 1)
            if r is None:
                return False
            length, vlen = r
            head = 1 + vlen
            if head + length > self.instr_remaining:
                raise FormatError("ADD overruns block instruction bytes")
            self._take(head)
            self.instr_remaining -= head
            self._add_remaining = length
            self._emit("add_begin", length)
            if length == 0:
                self._emit("add_end")
            return True
        if op in _COPY_NAMES:
            r1 = decode_prefix(self.buffer, 1)
            if r1 is None:
                return False
            off, l1 = r1
            r2 = decode_prefix(self.buffer, 1 + l1)
            if r2 is None:
                return False
            length, l2 = r2
            total = 1 + l1 + l2
            if total > self.instr_remaining:
                raise FormatError("COPY overruns block instruction bytes")
            self._take(total)
            self.instr_remaining -= total
            self._emit(_COPY_NAMES[op], off, length)
            return True
        raise FormatError(f"unknown opcode 0x{op:02x}")

    def _p_trailer(self):
        if self.step == 0:
            r = decode_prefix(self.buffer)
            if r is None:
                return False
            self._vals = [r[0]]
            self._take(r[1])
            self.step = 1
        else:
            if len(self.buffer) < HASH_SIZE:
                return False
            sha = bytes(self.buffer[:HASH_SIZE])
            self._take(HASH_SIZE)
            total = self._vals[0]
            self._vals = None
            self.step = 0
            self.finished = True
            self._emit("trailer", total, sha)
            self._emit("done")
        return True
