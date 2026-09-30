"""rollsync: binary delta generation and application.

Design notes
------------
* OLD is split into fixed-size blocks. The block size is a deterministic
  function of ``len(old)`` and ``seed`` (default 17), capped at 64 KiB, so
  block boundaries are fully determined by the OLD size and the seed.
* NEW is scanned with a rolling Adler-32 weak checksum over a window of at
  most 64 KiB (the block size). Every weak hit is arbitrated by re-hashing
  the window with SHA-256; a weak hit without a strong match is a false
  hit and is rejected.
* Overlapping matches in NEW are resolved by taking, at each position, the
  longest candidate first (full block before the trailing partial block),
  scanning left to right -- i.e. matches are picked by ascending start,
  then descending length, first one wins.
* A patch is a header plus a sequence of copy/literal ops. Every op carries
  its absolute target offset in NEW, so ops may be applied in any order and
  the result is deterministic. Applying the same patch repeatedly is
  idempotent.
* The header stores the SHA-256 of the expected result. ``apply_patch``
  verifies it before returning; the CLI exits with code 6 and does not
  touch the target file on mismatch.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from typing import NamedTuple

__all__ = [
    "DEFAULT_SEED",
    "MAX_WINDOW",
    "MOD_ADLER",
    "MAGIC",
    "PatchMeta",
    "PatchCorruptError",
    "HashMismatchError",
    "derive_block_size",
    "weak_checksum",
    "RollingAdler",
    "find_matches",
    "delta",
    "serialize_patch",
    "parse_patch",
    "apply_patch",
    "summarize",
]

DEFAULT_SEED = 17
MAX_WINDOW = 65536  # 64 KiB rolling window
MOD_ADLER = 65521
MAGIC = b"RLSYNC01"

_OP_END = 0x00
_OP_COPY = 0x01
_OP_LITERAL = 0x02

_HEADER = struct.Struct(">8sIIQQ32s")
_OP_COPY_HDR = struct.Struct(">BQQQ")
_OP_LIT_HDR = struct.Struct(">BQQ")
_OP_END_HDR = struct.Struct(">B")

HEADER_SIZE = _HEADER.size


class PatchMeta(NamedTuple):
    seed: int
    block_size: int
    old_len: int
    new_len: int
    new_sha256: bytes


class PatchCorruptError(Exception):
    """The patch is malformed, truncated, or internally inconsistent."""


class HashMismatchError(Exception):
    """The reconstructed bytes fail the patch's SHA-256 verification."""


def derive_block_size(old_len: int, seed: int = DEFAULT_SEED) -> int:
    """Deterministic block size from the OLD size and the seed.

    OLD is split into roughly ``seed`` blocks; the size is clamped to
    [1, 64 KiB]. Returns 0 for an empty OLD.
    """
    if old_len <= 0:
        return 0
    nblocks = max(1, seed)
    size = -(-old_len // nblocks)  # ceil division
    return max(1, min(MAX_WINDOW, size))


def weak_checksum(data: bytes, seed: int = DEFAULT_SEED) -> int:
    """Weak rolling-checksum-compatible Adler-32 of *data*."""
    return zlib.adler32(data, seed) & 0xFFFFFFFF


class RollingAdler:
    """Rolling Adler-32 compatible with ``zlib.adler32(window, seed)``."""

    __slots__ = ("n", "a", "b", "a0")

    def __init__(self, window: bytes, seed: int = DEFAULT_SEED):
        self.n = len(window)
        self.a0 = seed & 0xFFFF
        a = seed & 0xFFFF
        b = (seed >> 16) & 0xFFFF
        for byte in window:
            a += byte
            b += a
        self.a = a % MOD_ADLER
        self.b = b % MOD_ADLER

    @property
    def digest(self) -> int:
        return (self.b << 16) | self.a

    def roll(self, out_byte: int, in_byte: int) -> int:
        """Slide the window one byte: drop *out_byte*, append *in_byte*."""
        self.a = (self.a - out_byte + in_byte) % MOD_ADLER
        self.b = (self.b - self.n * out_byte + self.a - self.a0) % MOD_ADLER
        return self.digest


def _build_index(old: bytes, block_size: int, seed: int):
    index = {}
    off = 0
    while off < len(old):
        blk = old[off:off + block_size]
        weak = weak_checksum(blk, seed)
        strong = hashlib.sha256(blk).digest()
        index.setdefault(weak, []).append((len(blk), off, strong))
        off += block_size
    # Same start -> longer block first; same length -> lowest OLD offset.
    for entries in index.values():
        entries.sort(key=lambda e: (-e[0], e[1]))
    return index


def find_matches(old: bytes, new: bytes, block_size: int | None = None,
                 seed: int = DEFAULT_SEED):
    """Return verified matches as ``(new_off, old_off, length)`` triples.

    Matches are selected greedily by ascending NEW start; at equal starts
    the longest candidate wins. Every candidate is confirmed with SHA-256,
    so Adler-32 collisions never produce a copy op.
    """
    old = bytes(old)
    new = bytes(new)
    if block_size is None:
        block_size = derive_block_size(len(old), seed)
    if block_size <= 0 or not old or not new:
        return []
    n = len(new)
    full = block_size
    rem = len(old) % full
    partial = rem if rem else 0
    index = _build_index(old, full, seed)

    matches = []
    i = 0
    roll_full = RollingAdler(new[0:full], seed) if n >= full else None
    roll_part = (RollingAdler(new[0:partial], seed)
                 if partial and n >= partial else None)
    while i < n:
        hit = None
        if roll_full is not None:
            entries = index.get(roll_full.digest)
            if entries:
                digest = None
                for blen, boff, bhash in entries:
                    if blen != full:
                        continue
                    if digest is None:
                        digest = hashlib.sha256(new[i:i + full]).digest()
                    if digest == bhash:
                        hit = (boff, full)
                        break
        if hit is None and roll_part is not None:
            entries = index.get(roll_part.digest)
            if entries:
                digest = None
                for blen, boff, bhash in entries:
                    if blen != partial:
                        continue
                    if digest is None:
                        digest = hashlib.sha256(new[i:i + partial]).digest()
                    if digest == bhash:
                        hit = (boff, partial)
                        break
        if hit is not None:
            boff, length = hit
            matches.append((i, boff, length))
            i += length
            roll_full = (RollingAdler(new[i:i + full], seed)
                         if i + full <= n else None)
            roll_part = (RollingAdler(new[i:i + partial], seed)
                         if partial and i + partial <= n else None)
        else:
            if roll_full is not None:
                if i + full < n:
                    roll_full.roll(new[i], new[i + full])
                else:
                    roll_full = None
            if roll_part is not None:
                if i + partial < n:
                    roll_part.roll(new[i], new[i + partial])
                else:
                    roll_part = None
            i += 1
    return matches


def delta(old: bytes, new: bytes, seed: int = DEFAULT_SEED) -> bytes:
    """Build a binary patch that transforms *old* into *new*."""
    old = bytes(old)
    new = bytes(new)
    block_size = derive_block_size(len(old), seed)
    matches = find_matches(old, new, block_size, seed) if block_size else []
    ops = []
    pos = 0
    for noff, ooff, length in matches:
        if noff > pos:
            ops.append(("literal", pos, new[pos:noff]))
        ops.append(("copy", noff, ooff, length))
        pos = noff + length
    if pos < len(new):
        ops.append(("literal", pos, new[pos:]))
    meta = PatchMeta(seed, block_size, len(old), len(new),
                     hashlib.sha256(new).digest())
    return serialize_patch(meta, ops)


def serialize_patch(meta: PatchMeta, ops) -> bytes:
    """Serialize *ops* (copy/literal) with header *meta* into patch bytes."""
    out = bytearray()
    out += _HEADER.pack(MAGIC, meta.seed, meta.block_size, meta.old_len,
                        meta.new_len, meta.new_sha256)
    for op in ops:
        if op[0] == "copy":
            _, noff, ooff, length = op
            out += _OP_COPY_HDR.pack(_OP_COPY, noff, ooff, length)
        elif op[0] == "literal":
            _, noff, data = op
            out += _OP_LIT_HDR.pack(_OP_LITERAL, noff, len(data))
            out += data
        else:
            raise ValueError(f"unknown op {op[0]!r}")
    out += _OP_END_HDR.pack(_OP_END)
    return bytes(out)


def parse_patch(patch: bytes):
    """Parse patch bytes into ``(PatchMeta, ops)``.

    Raises :class:`PatchCorruptError` on any truncation or malformation.
    """
    patch = bytes(patch)
    if len(patch) < HEADER_SIZE:
        raise PatchCorruptError("patch shorter than header")
    magic, seed, block_size, old_len, new_len, new_sha = _HEADER.unpack_from(patch, 0)
    if magic != MAGIC:
        raise PatchCorruptError("bad magic")
    meta = PatchMeta(seed, block_size, old_len, new_len, new_sha)
    ops = []
    off = HEADER_SIZE
    while True:
        if off >= len(patch):
            raise PatchCorruptError("truncated: missing terminator")
        tag = patch[off]
        if tag == _OP_END:
            off += _OP_END_HDR.size
            break
        if tag == _OP_COPY:
            if off + _OP_COPY_HDR.size > len(patch):
                raise PatchCorruptError("truncated copy op")
            _, noff, ooff, length = _OP_COPY_HDR.unpack_from(patch, off)
            off += _OP_COPY_HDR.size
            ops.append(("copy", noff, ooff, length))
        elif tag == _OP_LITERAL:
            if off + _OP_LIT_HDR.size > len(patch):
                raise PatchCorruptError("truncated literal header")
            _, noff, length = _OP_LIT_HDR.unpack_from(patch, off)
            off += _OP_LIT_HDR.size
            if off + length > len(patch):
                raise PatchCorruptError("truncated literal data")
            ops.append(("literal", noff, patch[off:off + length]))
            off += length
        else:
            raise PatchCorruptError(f"unknown op tag {tag}")
    if off != len(patch):
        raise PatchCorruptError("trailing bytes after terminator")
    return meta, ops


def apply_patch(old: bytes, patch: bytes) -> bytes:
    """Apply *patch* to *old* and return the reconstructed bytes.

    Ops carry absolute target offsets, so application order is irrelevant
    and the result is deterministic. Raises :class:`PatchCorruptError` for
    malformed patches and :class:`HashMismatchError` when the result fails
    the SHA-256 check.
    """
    old = bytes(old)
    meta, ops = parse_patch(patch)
    segments = []
    for op in ops:
        if op[0] == "copy":
            _, noff, ooff, length = op
            if ooff + length > meta.old_len or noff + length > meta.new_len:
                raise PatchCorruptError("copy op out of bounds")
            segments.append((noff, length))
        else:
            _, noff, data = op
            if noff + len(data) > meta.new_len:
                raise PatchCorruptError("literal op out of bounds")
            segments.append((noff, len(data)))
    segments.sort()
    pos = 0
    for noff, length in segments:
        if noff != pos:
            raise PatchCorruptError("ops overlap or leave gaps")
        pos = noff + length
    if pos != meta.new_len:
        raise PatchCorruptError("ops do not cover the whole target")
    out = bytearray(meta.new_len)
    for op in ops:
        if op[0] == "copy":
            _, noff, ooff, length = op
            if ooff + length > len(old):
                raise HashMismatchError("OLD input does not match the patch")
            out[noff:noff + length] = old[ooff:ooff + length]
        else:
            _, noff, data = op
            out[noff:noff + len(data)] = data
    result = bytes(out)
    if hashlib.sha256(result).digest() != meta.new_sha256:
        raise HashMismatchError("reconstructed bytes fail sha256 verification")
    return result


def summarize(ops):
    """Return ``(copy_bytes, literal_bytes)`` for an op list."""
    copy_bytes = sum(op[3] for op in ops if op[0] == "copy")
    literal_bytes = sum(len(op[2]) for op in ops if op[0] == "literal")
    return copy_bytes, literal_bytes
