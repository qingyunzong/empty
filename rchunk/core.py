"""rchunk: content-defined chunking core.

Parameters
----------
- Window W = 48 bytes.
- Weak checksum: 31-bit polynomial rolling sum,
  h = (h * BASE + byte) mod 2**31 over the last W bytes.
- Cut point: after a byte, if chunk length >= 64 and the low 13 bits of
  the rolling hash are all ones (h & 0x1FFF == 0x1FFF), or at EOF.
- Hard limit: chunk length 4096 forces a cut even without a hash hit.
  When both conditions coincide on the same byte, the cut happens at
  that byte regardless (whichever condition is reached first wins).

Determinism: chunk boundaries depend only on the byte stream, never on
the buffer sizes used to feed the chunker.
"""
from __future__ import annotations

import bisect
import hashlib

WINDOW = 48
MIN_CHUNK = 64
MAX_CHUNK = 4096
MASK = 0x1FFF  # low 13 bits all ones
MOD = 1 << 31  # 31-bit rolling sum
BASE = 257

# BASE ** (WINDOW - 1) mod MOD, used to roll the oldest byte out.
_POW = pow(BASE, WINDOW - 1, MOD)

FORMAT = "rchunk-index-v1"
PARAMS = {
    "window": WINDOW,
    "min": MIN_CHUNK,
    "max": MAX_CHUNK,
    "mask": MASK,
    "mod_bits": 31,
    "base": BASE,
}


class CorruptError(Exception):
    """Raised when an index fails validation against the data.

    ``offset`` is the smallest offset at which corruption was detected,
    when known.
    """

    def __init__(self, message, offset=None):
        super().__init__(message)
        self.offset = offset


class Chunker:
    """Streaming content-defined chunker.

    Feed bytes with :meth:`feed` in arbitrarily sized buffers; call
    :meth:`finish` at EOF. The resulting ``(offset, len)`` chunk list is
    identical for any buffering of the same byte stream.
    """

    __slots__ = ("_ring", "_fill", "_pos", "_hash", "_offset",
                 "_chunk_start", "_chunks")

    def __init__(self):
        self._ring = [0] * WINDOW  # circular buffer of the last WINDOW bytes
        self._fill = 0             # valid bytes in the ring (<= WINDOW)
        self._pos = 0              # next write slot; oldest byte when full
        self._hash = 0
        self._offset = 0           # total bytes consumed
        self._chunk_start = 0
        self._chunks = []

    def feed(self, data):
        ring = self._ring
        fill = self._fill
        pos = self._pos
        h = self._hash
        offset = self._offset
        start = self._chunk_start
        chunks = self._chunks
        for byte in data:
            if fill == WINDOW:
                h = ((h - ring[pos] * _POW) * BASE + byte) % MOD
            else:
                h = (h * BASE + byte) % MOD
                fill += 1
            ring[pos] = byte
            pos += 1
            if pos == WINDOW:
                pos = 0
            offset += 1
            clen = offset - start
            if clen >= MIN_CHUNK and (h & MASK) == MASK:
                chunks.append((start, clen))
                start = offset
            elif clen == MAX_CHUNK:
                chunks.append((start, clen))
                start = offset
        self._fill = fill
        self._pos = pos
        self._hash = h
        self._offset = offset
        self._chunk_start = start

    def finish(self):
        """Flush the final partial chunk (EOF cut) and return all chunks."""
        if self._offset > self._chunk_start:
            self._chunks.append(
                (self._chunk_start, self._offset - self._chunk_start))
            self._chunk_start = self._offset
        return list(self._chunks)


def chunk_bytes(data):
    """Chunk a complete in-memory byte string."""
    chunker = Chunker()
    chunker.feed(data)
    return chunker.finish()


def build_index(data):
    """Build a .chunk index (as a JSON-able dict) for ``data``."""
    chunks = []
    for offset, length in chunk_bytes(data):
        digest = hashlib.sha256(data[offset:offset + length]).hexdigest()
        chunks.append({"offset": offset, "len": length, "sha256": digest})
    return {
        "format": FORMAT,
        "params": dict(PARAMS),
        "size": len(data),
        "chunks": chunks,
    }


def _entry(entry):
    try:
        offset = entry["offset"]
        length = entry["len"]
        digest = entry["sha256"]
    except (TypeError, KeyError) as exc:
        raise CorruptError("malformed chunk entry: %s" % exc) from exc
    if not (isinstance(offset, int) and isinstance(length, int)
            and isinstance(digest, str)):
        raise CorruptError("malformed chunk entry: bad field types")
    return offset, length, digest


def verify_index(data, index):
    """Rebuild mode: verify ``data`` against ``index``.

    Raises :class:`CorruptError` on any inconsistency: wrong format or
    parameters, offsets not strictly ascending and contiguous (any gap
    or overlap), size mismatch, or a chunk hash that does not match the
    data. The first bad chunk is reported with the smallest offset.
    """
    try:
        fmt = index["format"]
        params = index["params"]
        size = index["size"]
        chunks = index["chunks"]
    except (TypeError, KeyError) as exc:
        raise CorruptError("malformed index: missing %s" % exc) from exc
    if fmt != FORMAT:
        raise CorruptError("unsupported index format: %r" % (fmt,))
    if params != PARAMS:
        raise CorruptError("index parameters do not match this implementation")
    if not isinstance(size, int) or size < 0:
        raise CorruptError("malformed index: bad size")
    if size != len(data):
        raise CorruptError(
            "index size %d != data size %d" % (size, len(data)),
            offset=min(size, len(data)))
    if not isinstance(chunks, list):
        raise CorruptError("malformed index: chunks is not a list")

    expected = 0
    for entry in chunks:
        offset, length, digest = _entry(entry)
        if length <= 0:
            raise CorruptError(
                "non-positive chunk length at offset %d" % offset,
                offset=offset)
        if offset != expected:
            which = "overlap" if offset < expected else "gap"
            raise CorruptError(
                "%s at offset %d: expected %d" % (which, offset, expected),
                offset=min(offset, expected))
        actual = hashlib.sha256(data[offset:offset + length]).hexdigest()
        if actual != digest:
            raise CorruptError("sha256 mismatch at offset %d" % offset,
                               offset=offset)
        expected = offset + length
    if expected != len(data):
        raise CorruptError(
            "chunks cover %d bytes, data has %d" % (expected, len(data)),
            offset=min(expected, len(data)))


def locate_chunk(index, offset):
    """Return the (unique, minimal) chunk covering byte ``offset``."""
    chunks = index["chunks"]
    offsets = [c["offset"] for c in chunks]
    i = bisect.bisect_right(offsets, offset) - 1
    if i < 0:
        raise CorruptError("offset %d not covered by index" % offset,
                           offset=offset)
    entry = chunks[i]
    if not (entry["offset"] <= offset < entry["offset"] + entry["len"]):
        raise CorruptError("offset %d not covered by index" % offset,
                           offset=offset)
    return entry
