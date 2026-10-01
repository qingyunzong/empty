"""Merkle index (midx) core: build, parse and locally verify .index files.

Index file layout (all integers big-endian)::

    "MIDX"                4 bytes magic
    u32                   block size in bytes (need not be a power of two)
    u64                   data file size in bytes
    u32                   leaf count (number of blocks)
    level 0 (leaves)      leaf_count * 32 bytes of sha256 hashes
    u32                   crc32 of the level-0 hash bytes
    level 1               ... hashes + crc32
    ...                   (every level except the root is followed by its crc32)
    root                  exactly 32 bytes, no crc32

The tree is a complete binary tree built bottom-up: nodes are paired left
to right; when a level has an odd node count the last node is duplicated
and paired with itself.  The tail block of the data file is hashed with
its actual (short) length.
"""

from __future__ import annotations

import hashlib
import struct
import zlib
from dataclasses import dataclass

MAGIC = b"MIDX"
HASH_LEN = 32
CRC_LEN = 4
HEADER_STRUCT = struct.Struct(">4sIQI")
HEADER_LEN = HEADER_STRUCT.size
CRC_STRUCT = struct.Struct(">I")
DEFAULT_BLOCK_SIZE = 1 << 20


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def parent_hash(left: bytes, right: bytes) -> bytes:
    return sha256(left + right)


def level_sizes(leaf_count: int) -> list[int]:
    """Node count of every level from leaves (index 0) up to the root (1)."""
    if leaf_count < 1:
        raise ValueError("leaf_count must be >= 1")
    sizes = [leaf_count]
    while sizes[-1] > 1:
        sizes.append((sizes[-1] + 1) // 2)
    return sizes


def build_levels(leaf_hashes: list[bytes]) -> list[list[bytes]]:
    """Build all tree levels bottom-up; levels[-1] is [root].

    An odd node at the end of a level is duplicated and paired with itself.
    """
    if not leaf_hashes:
        raise ValueError("need at least one leaf hash")
    for h in leaf_hashes:
        if len(h) != HASH_LEN:
            raise ValueError("leaf hash must be 32 bytes")
    levels = [list(leaf_hashes)]
    while len(levels[-1]) > 1:
        current = levels[-1]
        nxt = []
        for i in range(0, len(current), 2):
            left = current[i]
            right = current[i + 1] if i + 1 < len(current) else left
            nxt.append(parent_hash(left, right))
        levels.append(nxt)
    return levels


@dataclass
class Index:
    block_size: int
    file_size: int
    leaf_count: int
    levels: list[list[bytes]]  # levels[0] = leaves, levels[-1] = [root]

    @property
    def root(self) -> bytes:
        return self.levels[-1][0]


def leaf_count_for(file_size: int, block_size: int) -> int:
    if block_size <= 0:
        raise ValueError("block_size must be positive")
    if file_size <= 0:
        raise ValueError("file_size must be positive")
    return (file_size + block_size - 1) // block_size


def compute_leaf_hashes(f, block_size: int, file_size: int) -> list[bytes]:
    """Stream the data file once, hashing each block (tail block: actual length)."""
    count = leaf_count_for(file_size, block_size)
    hashes = []
    for b in range(count):
        actual = min(block_size, file_size - b * block_size)
        data = f.read(actual)
        if len(data) != actual:
            raise IOError(
                f"short read at block {b}: wanted {actual} bytes, got {len(data)}"
            )
        hashes.append(sha256(data))
    return hashes


def build_index_bytes(block_size: int, file_size: int, leaf_hashes: list[bytes]) -> bytes:
    levels = build_levels(leaf_hashes)
    parts = [HEADER_STRUCT.pack(MAGIC, block_size, file_size, len(leaf_hashes))]
    for level in levels[:-1]:  # every level except the root gets a crc32
        blob = b"".join(level)
        parts.append(blob)
        parts.append(CRC_STRUCT.pack(zlib.crc32(blob) & 0xFFFFFFFF))
    parts.append(levels[-1][0])  # root: fixed 32 bytes, no crc32
    return b"".join(parts)


def parse(data: bytes) -> Index:
    """Parse and fully validate an index file.

    Raises builtin IndexError on any corruption: bad magic, truncated or
    trailing bytes, crc32 mismatch on any non-root level, or an internally
    inconsistent tree.
    """
    if len(data) < HEADER_LEN + HASH_LEN:
        raise IndexError("index too short")
    magic, block_size, file_size, leaf_count = HEADER_STRUCT.unpack_from(data, 0)
    if magic != MAGIC:
        raise IndexError("bad magic")
    if block_size <= 0:
        raise IndexError("invalid block size")
    if leaf_count <= 0:
        raise IndexError("invalid leaf count")
    if leaf_count_for(file_size, block_size) != leaf_count:
        raise IndexError("leaf count does not match file size / block size")
    sizes = level_sizes(leaf_count)
    pos = HEADER_LEN
    levels: list[list[bytes]] = []
    for n in sizes[:-1]:
        blob_len = n * HASH_LEN
        end = pos + blob_len + CRC_LEN
        if end > len(data):
            raise IndexError("truncated level")
        blob = data[pos : pos + blob_len]
        (crc,) = CRC_STRUCT.unpack_from(data, pos + blob_len)
        if crc != zlib.crc32(blob) & 0xFFFFFFFF:
            raise IndexError("crc32 mismatch")
        levels.append([blob[i * HASH_LEN : (i + 1) * HASH_LEN] for i in range(n)])
        pos = end
    if pos + HASH_LEN != len(data):
        raise IndexError("root truncated or trailing garbage")
    levels.append([data[pos : pos + HASH_LEN]])
    index = Index(block_size, file_size, leaf_count, levels)
    if build_levels(levels[0]) != levels:
        raise IndexError("internally inconsistent tree")
    return index


def load_index(path: str) -> Index:
    with open(path, "rb") as f:
        return parse(f.read())


def verify_leaf_path(index: Index, leaf_index: int, leaf_hash: bytes) -> bool:
    """Verify one leaf hash against the stored Merkle path up to the root."""
    if leaf_hash != index.levels[0][leaf_index]:
        return False
    computed = leaf_hash
    idx = leaf_index
    for depth in range(len(index.levels) - 1):
        level = index.levels[depth]
        if idx % 2 == 0:
            sibling = level[idx + 1] if idx + 1 < len(level) else level[idx]
            computed = parent_hash(computed, sibling)
        else:
            computed = parent_hash(level[idx - 1], computed)
        idx //= 2
        if computed != index.levels[depth + 1][idx]:
            return False
    return computed == index.root


def verify_range(f, index: Index, offset: int, length: int) -> list[int]:
    """Verify only the blocks covering [offset, offset+length).

    Reads nothing but those blocks from the data file (seek + read per
    block, never a full scan).  Returns the bad block numbers in ascending
    order (empty list means OK).
    """
    if offset < 0 or length < 0:
        raise ValueError("offset/length must be >= 0")
    if length == 0 or offset >= index.file_size:
        return []
    first = offset // index.block_size
    last = min((offset + length - 1) // index.block_size, index.leaf_count - 1)
    bad = []
    for b in range(first, last + 1):
        actual = min(index.block_size, index.file_size - b * index.block_size)
        f.seek(b * index.block_size)
        data = f.read(actual)
        if len(data) != actual or not verify_leaf_path(index, b, sha256(data)):
            bad.append(b)
    return bad
