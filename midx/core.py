"""midx core: Merkle index over fixed-size file blocks (sha256).

Index file layout (all integers little-endian):
    4s   magic b"MIDX"
    u32  block_size
    u64  file_size
    u32  leaf_count
    then for every tree level except the root (leaves first, bottom-up):
        n * 32 bytes of sha256 hashes
        u32 crc32 of those n*32 bytes
    finally:
        32 bytes root hash (no crc32)

Tree rule: each parent is sha256(left + right); a level with an odd
node count duplicates its last node. The root is always 32 bytes.
Any structural or crc32 corruption raises IndexError.
"""

import hashlib
import os
import struct
import zlib

MAGIC = b"MIDX"
HASH_SIZE = 32
HEADER = struct.Struct("<4sIQI")
CRC = struct.Struct("<I")


class MidxIndex:
    """Parsed index: block_size, file_size and all tree levels."""

    def __init__(self, block_size, file_size, levels):
        self.block_size = block_size
        self.file_size = file_size
        self.levels = levels  # levels[0] = leaves, levels[-1] = [root]

    @property
    def leaf_count(self):
        return len(self.levels[0])

    @property
    def root(self):
        return self.levels[-1][0]


def hash_block(data):
    return hashlib.sha256(data).digest()


def build_levels(leaf_hashes):
    """Bottom-up complete binary tree; odd node duplicates itself."""
    if not leaf_hashes:
        raise ValueError("need at least one leaf")
    levels = [list(leaf_hashes)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            left = cur[i]
            right = cur[i + 1] if i + 1 < len(cur) else left
            nxt.append(hashlib.sha256(left + right).digest())
        levels.append(nxt)
    return levels


def serialize(index):
    out = [HEADER.pack(MAGIC, index.block_size, index.file_size,
                       index.leaf_count)]
    for level in index.levels[:-1]:
        raw = b"".join(level)
        out.append(raw)
        out.append(CRC.pack(zlib.crc32(raw)))
    out.append(index.root)
    return b"".join(out)


def parse(data):
    """Parse index bytes; raise IndexError on any corruption."""
    if len(data) < HEADER.size:
        raise IndexError("index too short for header")
    magic, block_size, file_size, leaf_count = HEADER.unpack_from(data, 0)
    if magic != MAGIC:
        raise IndexError("bad magic")
    if block_size == 0:
        raise IndexError("block size is zero")
    if leaf_count == 0:
        raise IndexError("leaf count is zero")
    pos = HEADER.size
    levels = []
    n = leaf_count
    while n > 1:
        need = n * HASH_SIZE
        if pos + need + CRC.size > len(data):
            raise IndexError("truncated level")
        raw = data[pos:pos + need]
        (crc,) = CRC.unpack_from(data, pos + need)
        if zlib.crc32(raw) != crc:
            raise IndexError("crc32 mismatch in level")
        levels.append([raw[i * HASH_SIZE:(i + 1) * HASH_SIZE]
                       for i in range(n)])
        pos += need + CRC.size
        n = (n + 1) // 2
    if pos + HASH_SIZE != len(data):
        raise IndexError("truncated or trailing bytes around root")
    levels.append([data[pos:pos + HASH_SIZE]])
    return MidxIndex(block_size, file_size, levels)


def load_index(path):
    with open(path, "rb") as f:
        return parse(f.read())


def build(file_path, block_size, index_path=None):
    """Stream the file once, block by block, and write the index."""
    if block_size <= 0:
        raise ValueError("block_size must be positive")
    leaves = []
    file_size = 0
    with open(file_path, "rb") as f:
        while True:
            chunk = f.read(block_size)
            if not chunk:
                break
            leaves.append(hash_block(chunk))
            file_size += len(chunk)
    if not leaves:  # empty file: single leaf over b""
        leaves.append(hash_block(b""))
    index = MidxIndex(block_size, file_size, build_levels(leaves))
    if index_path is None:
        index_path = file_path + ".index"
    with open(index_path, "wb") as f:
        f.write(serialize(index))
    return index, index_path


def verify_block(index, block_index, data):
    """Verify one block via its Merkle path using stored siblings."""
    if not 0 <= block_index < index.leaf_count:
        raise ValueError("block index out of range")
    h = hash_block(data)
    i = block_index
    for level in index.levels[:-1]:
        n = len(level)
        if i % 2 == 0:
            sib = level[i + 1] if i + 1 < n else h
            h = hashlib.sha256(h + sib).digest()
        else:
            h = hashlib.sha256(level[i - 1] + h).digest()
        i //= 2
    return h == index.root


def verify_range(index, file_path, offset=0, length=None):
    """Verify blocks covering [offset, offset+length).

    Only the covering blocks are read from the data file. Returns the
    list of bad block indices in ascending order (empty means OK).
    """
    if offset < 0:
        raise ValueError("offset must be >= 0")
    end = index.file_size if length is None else min(offset + length,
                                                     index.file_size)
    if end <= offset:
        return []
    first = offset // index.block_size
    last = (end - 1) // index.block_size
    bad = []
    with open(file_path, "rb") as f:
        for b in range(first, last + 1):
            start = b * index.block_size
            want = min(index.block_size, index.file_size - start)
            f.seek(start)
            data = f.read(want)
            if not verify_block(index, b, data):
                bad.append(b)
    return bad
