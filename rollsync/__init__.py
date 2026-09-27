"""rollsync: rsync-style binary delta generation and application.

Design notes
------------
* OLD is split into fixed-size blocks.  The block size is a pure function of
  ``len(old)`` and ``seed`` (default 17), capped at 64 KiB so the weak
  checksum window never exceeds 64 KB.
* A rolling Adler-32 weak checksum is computed over NEW with a window equal
  to the block size.  Every weak hit MUST be confirmed with SHA-256 before a
  copy segment is emitted; weak collisions that fail the strong check are
  silently rejected (no false hits).
* Overlapping matches in NEW are resolved by ascending start offset and, at
  the same start offset, by descending length (the full-block window is
  always tried before the shorter tail-block window).
* A PATCH is a self-describing list of copy/literal segments, each carrying
  its output offset, so segments may be applied in any order with a
  deterministic result.  Re-applying a patch is idempotent.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass, field
from typing import List, Tuple, Union

MAGIC = b"RLSYNC01"
SEED = 17
MAX_BLOCK_SIZE = 64 * 1024  # 64 KB Adler-32 window cap
_MOD_ADLER = 65521

EXIT_OK = 0
EXIT_IO = 2
EXIT_CORRUPT = 5
EXIT_CHECKSUM = 6

_TAG_COPY = 0x01
_TAG_LITERAL = 0x02

_U64 = struct.Struct(">Q")
_HEADER = struct.Struct(">8sQQ32sQ")  # magic, old_size, new_size, new_sha256, num_segments
_COPY_FIXED = struct.Struct(">BQQQ")  # tag, out_offset, old_offset, length
_LIT_FIXED = struct.Struct(">BQQ")  # tag, out_offset, length


class CorruptPatchError(Exception):
    """The patch byte stream is malformed, truncated or inconsistent."""


class ChecksumMismatchError(Exception):
    """A SHA-256 verification failed while applying the patch."""


def block_size_for(old_size: int, seed: int = SEED) -> int:
    """Deterministic block size derived from OLD size and the seed."""
    if old_size <= 0:
        return 1
    return max(1, min(MAX_BLOCK_SIZE, old_size // seed))


@dataclass
class CopySegment:
    out_offset: int
    old_offset: int
    length: int
    sha256: bytes  # SHA-256 of old[old_offset:old_offset + length]


@dataclass
class LiteralSegment:
    out_offset: int
    data: bytes


Segment = Union[CopySegment, LiteralSegment]


@dataclass
class Patch:
    old_size: int
    new_size: int
    new_sha256: bytes
    segments: List[Segment] = field(default_factory=list)


def _build_block_index(old: bytes, block_size: int):
    """Map weak Adler-32 digest -> [(length, offset, sha256), ...].

    Candidates are ordered by descending length then ascending offset so that
    the first strong-verified candidate realises the required
    "ascending start, descending length" overlap rule.
    """
    index = {}
    offset = 0
    old_len = len(old)
    while offset < old_len:
        block = old[offset:offset + block_size]
        weak = zlib.adler32(block)
        strong = hashlib.sha256(block).digest()
        index.setdefault(weak, []).append((len(block), offset, strong))
        offset += block_size
    for candidates in index.values():
        candidates.sort(key=lambda item: (-item[0], item[1]))
    return index


def delta(old: bytes, new: bytes, seed: int = SEED) -> Patch:
    """Compute a Patch that transforms ``old`` into ``new``."""
    old = bytes(old)
    new = bytes(new)
    block_size = block_size_for(len(old), seed)
    index = _build_block_index(old, block_size)

    # Tail block of OLD may be shorter than block_size; track it with a
    # second rolling window so it can still be matched in O(1) per position.
    blocks = [old[o:o + block_size] for o in range(0, len(old), block_size)]
    has_short = bool(blocks) and len(blocks[-1]) != block_size
    short_len = len(blocks[-1]) if has_short else 0

    segments: List[Segment] = []
    n = len(new)
    i = 0
    literal_start = 0

    # Rolling state for the main window (block_size) and the tail window.
    s1 = s2 = 0
    valid = False
    t1 = t2 = 0
    tvalid = False
    mod = _MOD_ADLER

    while i < n:
        matched: Union[Tuple[int, int], None] = None

        limit = i + block_size
        if limit <= n:
            if valid:
                out_b = new[i - 1]
                in_b = new[limit - 1]
                s1 = (s1 - out_b + in_b) % mod
                s2 = (s2 - block_size * out_b + s1 - 1) % mod
            else:
                digest = zlib.adler32(new[i:limit])
                s1 = digest & 0xFFFF
                s2 = (digest >> 16) & 0xFFFF
                valid = True
            candidates = index.get((s2 << 16) | s1)
            if candidates is not None:
                window = new[i:limit]
                for length, old_offset, strong in candidates:
                    if length != block_size:
                        continue
                    # Strong verification: weak hits must survive SHA-256.
                    if hashlib.sha256(window).digest() == strong:
                        matched = (old_offset, block_size)
                        break

        if matched is None and has_short and i + short_len <= n:
            if tvalid:
                out_b = new[i - 1]
                in_b = new[i + short_len - 1]
                t1 = (t1 - out_b + in_b) % mod
                t2 = (t2 - short_len * out_b + t1 - 1) % mod
            else:
                digest = zlib.adler32(new[i:i + short_len])
                t1 = digest & 0xFFFF
                t2 = (digest >> 16) & 0xFFFF
                tvalid = True
            candidates = index.get((t2 << 16) | t1)
            if candidates is not None:
                window = new[i:i + short_len]
                for length, old_offset, strong in candidates:
                    if length != short_len:
                        continue
                    if hashlib.sha256(window).digest() == strong:
                        matched = (old_offset, short_len)
                        break

        if matched is not None:
            old_offset, length = matched
            if i > literal_start:
                segments.append(LiteralSegment(literal_start, new[literal_start:i]))
            block = old[old_offset:old_offset + length]
            segments.append(CopySegment(i, old_offset, length,
                                        hashlib.sha256(block).digest()))
            i += length
            literal_start = i
            valid = False
            tvalid = False
        else:
            i += 1

    if n > literal_start:
        segments.append(LiteralSegment(literal_start, new[literal_start:]))

    return Patch(
        old_size=len(old),
        new_size=n,
        new_sha256=hashlib.sha256(new).digest(),
        segments=segments,
    )


def serialize_patch(patch: Patch) -> bytes:
    out = bytearray()
    out += _HEADER.pack(MAGIC, patch.old_size, patch.new_size,
                        patch.new_sha256, len(patch.segments))
    for segment in patch.segments:
        if isinstance(segment, CopySegment):
            out += _COPY_FIXED.pack(_TAG_COPY, segment.out_offset,
                                    segment.old_offset, segment.length)
            out += segment.sha256
        elif isinstance(segment, LiteralSegment):
            out += _LIT_FIXED.pack(_TAG_LITERAL, segment.out_offset,
                                   len(segment.data))
            out += segment.data
        else:  # pragma: no cover - defensive
            raise TypeError(f"unknown segment type: {type(segment)!r}")
    return bytes(out)


def parse_patch(data: bytes) -> Patch:
    if len(data) < _HEADER.size:
        raise CorruptPatchError("patch too short for header")
    magic, old_size, new_size, new_sha256, num_segments = _HEADER.unpack(
        data[:_HEADER.size])
    if magic != MAGIC:
        raise CorruptPatchError("bad magic")

    segments: List[Segment] = []
    cursor = _HEADER.size
    end = len(data)
    for _ in range(num_segments):
        if cursor >= end:
            raise CorruptPatchError("truncated segment table")
        tag = data[cursor]
        if tag == _TAG_COPY:
            if cursor + _COPY_FIXED.size + 32 > end:
                raise CorruptPatchError("truncated copy segment")
            _, out_off, old_off, length = _COPY_FIXED.unpack(
                data[cursor:cursor + _COPY_FIXED.size])
            cursor += _COPY_FIXED.size
            strong = data[cursor:cursor + 32]
            cursor += 32
            if old_off + length > old_size:
                raise CorruptPatchError("copy segment out of OLD bounds")
            segments.append(CopySegment(out_off, old_off, length, strong))
        elif tag == _TAG_LITERAL:
            if cursor + _LIT_FIXED.size > end:
                raise CorruptPatchError("truncated literal segment")
            _, out_off, length = _LIT_FIXED.unpack(
                data[cursor:cursor + _LIT_FIXED.size])
            cursor += _LIT_FIXED.size
            if cursor + length > end:
                raise CorruptPatchError("truncated literal payload")
            segments.append(LiteralSegment(out_off, data[cursor:cursor + length]))
            cursor += length
        else:
            raise CorruptPatchError(f"unknown segment tag {tag}")

    if cursor != end:
        raise CorruptPatchError("trailing garbage after segments")

    # Segments must tile [0, new_size) exactly, without overlap, so that
    # applying them in any order yields the same deterministic bytes.
    cursor = 0
    for segment in sorted(segments, key=lambda s: s.out_offset):
        length = (segment.length if isinstance(segment, CopySegment)
                  else len(segment.data))
        if segment.out_offset != cursor:
            raise CorruptPatchError("segments do not tile the output")
        cursor += length
    if cursor != new_size:
        raise CorruptPatchError("segments do not cover the whole output")

    return Patch(old_size=old_size, new_size=new_size,
                 new_sha256=new_sha256, segments=segments)


def apply_patch(old: bytes, patch_data: bytes) -> Tuple[bytes, int, int]:
    """Apply ``patch_data`` to ``old``.

    Returns ``(new_bytes, copy_bytes, literal_bytes)``.  Raises
    :class:`CorruptPatchError` for malformed patches and
    :class:`ChecksumMismatchError` when any SHA-256 verification fails.
    Nothing is written anywhere on failure; the caller owns all IO.
    """
    old = bytes(old)
    patch = parse_patch(patch_data)
    if len(old) != patch.old_size:
        raise CorruptPatchError("OLD size does not match patch header")

    buffer = bytearray(patch.new_size)
    copy_bytes = 0
    literal_bytes = 0
    for segment in patch.segments:
        if isinstance(segment, CopySegment):
            chunk = old[segment.old_offset:segment.old_offset + segment.length]
            if len(chunk) != segment.length:
                raise CorruptPatchError("copy segment out of OLD bounds")
            if hashlib.sha256(chunk).digest() != segment.sha256:
                raise ChecksumMismatchError(
                    f"copy segment at old offset {segment.old_offset} "
                    "failed SHA-256 verification")
            buffer[segment.out_offset:segment.out_offset + segment.length] = chunk
            copy_bytes += segment.length
        else:
            buffer[segment.out_offset:segment.out_offset + len(segment.data)] = \
                segment.data
            literal_bytes += len(segment.data)

    result = bytes(buffer)
    if hashlib.sha256(result).digest() != patch.new_sha256:
        raise ChecksumMismatchError("reconstructed output failed SHA-256 check")
    return result, copy_bytes, literal_bytes
