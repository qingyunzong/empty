"""rchunk content-defined chunking core.

Chunking rules (deterministic, independent of read buffer size):

- A 48-byte rolling window feeds a 31-bit polynomial rolling checksum:
  h = (h * BASE + byte) mod 2**31, sliding removes out * BASE**(W-1).
- Cut when the low 13 bits of the checksum are all 1s AND the current
  chunk length has reached MIN_SIZE (64).
- Cut unconditionally when the chunk length reaches MAX_SIZE (4096),
  even if the fingerprint did not match. If both conditions coincide on
  the same byte, the forced cut (reached first by length) wins; both
  produce the same boundary.
- Cut at EOF for any remaining bytes.

The rolling state resets at every chunk boundary, so each boundary
depends only on the bytes of the current chunk.
"""

from __future__ import annotations

WINDOW = 48
MIN_SIZE = 64
MAX_SIZE = 4096
MASK = 0x1FFF  # low 13 bits
MOD = 1 << 31
BASE = 257
_POW_BASE = pow(BASE, WINDOW - 1, MOD)


class RollingHash:
    """31-bit polynomial rolling checksum over a window of WINDOW bytes."""

    __slots__ = ("h", "_buf", "_count")

    def __init__(self) -> None:
        self.h = 0
        self._buf = [0] * WINDOW
        self._count = 0

    def reset(self) -> None:
        self.h = 0
        self._count = 0

    def update(self, byte: int) -> None:
        count = self._count
        h = self.h
        slot = count % WINDOW
        if count >= WINDOW:
            h = (h - self._buf[slot] * _POW_BASE) % MOD
        self._buf[slot] = byte
        self._count = count + 1
        self.h = (h * BASE + byte) % MOD

    def boundary(self) -> bool:
        """True when the low 13 bits of the checksum are all 1s."""
        return (self.h & MASK) == MASK


class Chunker:
    """Streaming content-defined chunker.

    Feed bytes with :meth:`feed` (any buffer sizes) and finalize with
    :meth:`finish`. Both return ``(offset, length)`` pairs for chunks
    completed during the call. The split of a byte stream is unique and
    does not depend on how the stream was buffered into feed calls.
    """

    __slots__ = ("_hash", "_start", "_pos")

    def __init__(self) -> None:
        self._hash = RollingHash()
        self._start = 0  # absolute offset of current chunk start
        self._pos = 0    # absolute offset of next byte to consume

    def feed(self, data: bytes) -> list[tuple[int, int]]:
        chunks: list[tuple[int, int]] = []
        h = self._hash
        pos = self._pos
        start = self._start
        for byte in data:
            h.update(byte)
            pos += 1
            length = pos - start
            if length == MAX_SIZE:
                # Forced cut at the hard limit, fingerprint or not.
                chunks.append((start, length))
                start = pos
                h.reset()
            elif length >= MIN_SIZE and h.boundary():
                chunks.append((start, length))
                start = pos
                h.reset()
        self._pos = pos
        self._start = start
        return chunks

    def finish(self) -> list[tuple[int, int]]:
        if self._pos > self._start:
            chunk = [(self._start, self._pos - self._start)]
            self._start = self._pos
            self._hash.reset()
            return chunk
        return []


def chunk_stream(data: bytes, buffer_size: int = 65536) -> list[tuple[int, int]]:
    """One-shot helper: chunk *data* reading it in buffer_size pieces."""
    if buffer_size <= 0:
        raise ValueError("buffer_size must be positive")
    chunker = Chunker()
    chunks: list[tuple[int, int]] = []
    for i in range(0, len(data), buffer_size):
        chunks.extend(chunker.feed(data[i:i + buffer_size]))
    chunks.extend(chunker.finish())
    return chunks
