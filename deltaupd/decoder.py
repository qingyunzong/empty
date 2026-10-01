"""Incremental decoder for the update stream format.

Stream layout::

    MAGIC (6 bytes) | baseline fingerprint (32) | num_blocks (varint)
    per block:  out_len (varint) | block sha256 (32) | instructions... | END_BLOCK
    final: total output sha256 (32)

Instructions::

    0x00 END_BLOCK
    0x01 ADD       len(varint)  payload(len bytes)
    0x02 COPY_BASE offset(varint) len(varint)
    0x03 COPY_OUT  distance(varint) len(varint)   # byte-by-byte, overlap allowed

The decoder accepts input in arbitrary byte slices.  Every ``feed`` call
returns a FeedResult with the events completed so far (each tagged with the
absolute stream offset of its end, i.e. a verified instruction boundary) and
``needed``: how many more bytes are required to complete the token currently
in progress.  Malformed input raises immediately (a definite error).
"""

from collections import namedtuple

from . import varint
from .errors import BadMagicError, TrailingDataError, UnknownOpcodeError

MAGIC = b"GUPD1\n"
FINGERPRINT_SIZE = 32
HASH_SIZE = 32

OP_END_BLOCK = 0x00
OP_ADD = 0x01
OP_COPY_BASE = 0x02
OP_COPY_OUT = 0x03

ADD_CHUNK = 1 << 16  # ADD payloads are streamed in chunks of at most 64 KiB

FeedResult = namedtuple("FeedResult", ("events", "needed"))

_FIXED = {  # state -> field size in bytes
    "magic": len(MAGIC),
    "fingerprint": FINGERPRINT_SIZE,
    "block_hash": HASH_SIZE,
    "final_hash": HASH_SIZE,
}


class Decoder:
    """Stateful stream decoder; resumable from an instruction boundary."""

    def __init__(self, *, phase="header", blocks_seen=0, num_blocks=None,
                 consumed=0):
        """``phase`` is one of: header, block_header, instructions, final."""
        self._buf = bytearray()
        self._base = consumed  # absolute stream offset of self._buf[0]
        self.blocks_seen = blocks_seen
        self.num_blocks = num_blocks
        self.done = False
        self._fingerprint = None
        self._block_len = None
        self._add_remaining = 0
        self._copy_offset = 0
        self._copy_distance = 0
        if phase == "header":
            self._state = "magic"
        elif phase == "block_header":
            self._state = "block_len"
        elif phase == "instructions":
            self._state = "opcode"
        elif phase == "final":
            self._state = "final_hash"
        else:
            raise ValueError(f"unknown phase {phase!r}")

    @property
    def consumed(self) -> int:
        """Absolute offset up to which the stream has been fully parsed."""
        return self._base

    def feed(self, data: bytes) -> FeedResult:
        if self.done and data:
            raise TrailingDataError("bytes after end of update stream")
        self._buf += data
        events = []
        pos = self._pump(events)
        if pos:
            del self._buf[:pos]
            self._base += pos
        if self.done and self._buf:
            raise TrailingDataError("bytes after end of update stream")
        return FeedResult(events, self._needed())

    # -- internal ------------------------------------------------------

    def _pump(self, events):
        """Parse as much as possible; return bytes consumed from the buffer."""
        pos = 0
        buf = self._buf
        while True:
            state = self._state
            if state in _FIXED:
                size = _FIXED[state]
                if len(buf) - pos < size:
                    break
                field = bytes(buf[pos:pos + size])
                pos += size
                if state == "magic":
                    if field != MAGIC:
                        raise BadMagicError(f"bad magic {field!r}")
                    self._state = "fingerprint"
                elif state == "fingerprint":
                    self._fingerprint = field
                    self._state = "num_blocks"
                elif state == "block_hash":
                    events.append((self._base + pos,
                                   ("block_header", self._block_len, field)))
                    self._state = "opcode"
                else:  # final_hash
                    events.append((self._base + pos, ("final_hash", field)))
                    self._state = "done"
                    self.done = True
                    break
            elif state in ("num_blocks", "block_len", "add_len",
                           "copy_base_off", "copy_base_len",
                           "copy_out_dist", "copy_out_len"):
                got = varint.decode(buf, pos)
                if got is None:
                    break
                value, pos = got
                if state == "num_blocks":
                    self.num_blocks = value
                    self.blocks_seen = 0
                    events.append((self._base + pos,
                                   ("header", self._fingerprint, value)))
                    self._state = "block_len" if value else "final_hash"
                elif state == "block_len":
                    self._block_len = value
                    self._state = "block_hash"
                elif state == "add_len":
                    self._add_remaining = value
                    events.append((self._base + pos, ("add_begin", value)))
                    if value == 0:
                        events.append((self._base + pos, ("add_end",)))
                        self._state = "opcode"
                    else:
                        self._state = "add_payload"
                elif state == "copy_base_off":
                    self._copy_offset = value
                    self._state = "copy_base_len"
                elif state == "copy_base_len":
                    events.append((self._base + pos,
                                   ("copy_base", self._copy_offset, value)))
                    self._state = "opcode"
                elif state == "copy_out_dist":
                    self._copy_distance = value
                    self._state = "copy_out_len"
                else:
                    events.append((self._base + pos,
                                   ("copy_out", self._copy_distance, value)))
                    self._state = "opcode"
            elif state == "opcode":
                if len(buf) - pos < 1:
                    break
                op = buf[pos]
                pos += 1
                if op == OP_END_BLOCK:
                    self.blocks_seen += 1
                    events.append((self._base + pos, ("end_block",)))
                    self._state = ("block_len"
                                   if self.blocks_seen < self.num_blocks
                                   else "final_hash")
                elif op == OP_ADD:
                    self._state = "add_len"
                elif op == OP_COPY_BASE:
                    self._state = "copy_base_off"
                elif op == OP_COPY_OUT:
                    self._state = "copy_out_dist"
                else:
                    raise UnknownOpcodeError(f"unknown opcode 0x{op:02x}")
            elif state == "add_payload":
                take = min(ADD_CHUNK, self._add_remaining, len(buf) - pos)
                if take <= 0:
                    break
                chunk = bytes(buf[pos:pos + take])
                pos += take
                self._add_remaining -= take
                events.append((self._base + pos, ("add_data", chunk)))
                if self._add_remaining == 0:
                    events.append((self._base + pos, ("add_end",)))
                    self._state = "opcode"
            else:  # done
                break
        return pos

    def _needed(self) -> int:
        """Bytes still required to complete the token in progress."""
        avail = len(self._buf)
        state = self._state
        if state == "done":
            return 0
        if state in _FIXED:
            return max(1, _FIXED[state] - avail)
        if state == "add_payload":
            return max(1, self._add_remaining - avail)
        # opcode or any varint state: one more byte always makes progress
        return 1
