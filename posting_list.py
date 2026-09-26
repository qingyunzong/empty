"""压缩文档ID差分列表（posting list）与跳跃块，仅依赖标准库（Python 3.11）。

编码格式
--------
* 文档ID必须严格递增的正整数（构建时校验，违反则抛 ValueError）。
* 相邻ID的差分 delta = id[i] - id[i-1]（约定 id[-1] = 0），正常数据恒有 delta >= 1。
* delta 先经 zigzag 变换再做 varint（LEB128）编码。zigzag 让负差分同样可以被
  解码出来，因此损坏的数据一旦产生 delta <= 0（ID 倒退或重复）就能被明确拒绝，
  抛出 CorruptedDeltaError，而不是静默产出错误结果。
* 列表按固定块大小切分；头部跳跃表记录每块的 (块内最大ID, 负载字节数)。
  advance(target) 据此整块跳过，被跳过的块不解码、不计入“实际解码块数”。

字节布局
--------
    varint(block_size) varint(count) varint(num_blocks)
    重复 num_blocks 次: varint(block_last_id) varint(block_payload_len)
    之后为各块负载（varint 编码的 zigzag 差分）顺序拼接
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_BLOCK_SIZE = 8


class CorruptedDeltaError(ValueError):
    """差分解码出非正值（文档ID倒退/重复）或字节流损坏时抛出。"""


def _encode_varint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varint 仅支持非负整数")
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def _decode_varint(buf: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise CorruptedDeltaError("varint 被截断：数据损坏")
        byte = buf[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise CorruptedDeltaError("varint 过长：数据损坏")


def _zigzag_encode(value: int) -> int:
    return (value << 1) if value >= 0 else ((-value << 1) - 1)


def _zigzag_decode(value: int) -> int:
    return (value >> 1) if not (value & 1) else -((value >> 1) + 1)


@dataclass
class DecodeStats:
    """解码统计：实际解码的块数与被跳跃表整块跳过的块数。"""

    decoded_blocks: int = 0
    skipped_blocks: int = 0


def _validate_doc_ids(ids: list[int]) -> None:
    for i, doc_id in enumerate(ids):
        if not isinstance(doc_id, int) or isinstance(doc_id, bool) or doc_id <= 0:
            raise ValueError(f"文档ID必须为正整数，得到 {doc_id!r}")
        if i and doc_id <= ids[i - 1]:
            raise ValueError(
                f"文档ID必须严格递增：第 {i} 项 {doc_id} 不大于前一项 {ids[i - 1]}"
            )


def _encode(ids: list[int], block_size: int) -> tuple[list[tuple[int, int]], bytes]:
    skip_table: list[tuple[int, int]] = []
    payload = bytearray()
    block = bytearray()
    prev = 0
    for i, doc_id in enumerate(ids):
        block += _encode_varint(_zigzag_encode(doc_id - prev))
        prev = doc_id
        if (i + 1) % block_size == 0:
            skip_table.append((doc_id, len(block)))
            payload += block
            block = bytearray()
    if block:
        skip_table.append((prev, len(block)))
        payload += block
    return skip_table, bytes(payload)


class PostingList:
    """压缩的文档ID列表，支持游标遍历、advance 跳跃与解码统计。"""

    def __init__(self, doc_ids=(), block_size: int = DEFAULT_BLOCK_SIZE):
        if block_size < 1:
            raise ValueError("block_size 必须 >= 1")
        ids = list(doc_ids)
        _validate_doc_ids(ids)
        self.block_size = block_size
        self.count = len(ids)
        self._skip_table, self._payload = _encode(ids, block_size)
        self._offsets = self._compute_offsets(self._skip_table)
        self.stats = DecodeStats()

    @staticmethod
    def _compute_offsets(skip_table: list[tuple[int, int]]) -> list[int]:
        offsets = []
        pos = 0
        for _, length in skip_table:
            offsets.append(pos)
            pos += length
        return offsets

    # ---- 序列化 ----

    def to_bytes(self) -> bytes:
        out = bytearray()
        out += _encode_varint(self.block_size)
        out += _encode_varint(self.count)
        out += _encode_varint(len(self._skip_table))
        for last_id, length in self._skip_table:
            out += _encode_varint(last_id)
            out += _encode_varint(length)
        out += self._payload
        return bytes(out)

    @classmethod
    def from_bytes(cls, data: bytes) -> "PostingList":
        obj = cls.__new__(cls)
        pos = 0
        obj.block_size, pos = _decode_varint(data, pos)
        obj.count, pos = _decode_varint(data, pos)
        num_blocks, pos = _decode_varint(data, pos)
        skip_table = []
        for _ in range(num_blocks):
            last_id, pos = _decode_varint(data, pos)
            length, pos = _decode_varint(data, pos)
            skip_table.append((last_id, length))
        payload = data[pos:]
        if sum(length for _, length in skip_table) != len(payload):
            raise CorruptedDeltaError("负载总长度与跳跃表不一致：数据损坏")
        obj._skip_table = skip_table
        obj._payload = payload
        obj._offsets = cls._compute_offsets(skip_table)
        obj.stats = DecodeStats()
        return obj

    # ---- 解码 ----

    def _decode_block(self, index: int) -> list[int]:
        last_id, length = self._skip_table[index]
        pos = self._offsets[index]
        end = pos + length
        prev = self._skip_table[index - 1][0] if index else 0
        items = []
        while pos < end:
            raw, pos = _decode_varint(self._payload, pos)
            delta = _zigzag_decode(raw)
            if delta <= 0:
                raise CorruptedDeltaError(
                    f"块 {index} 解码出非正差分 {delta}：文档ID倒退/重复，数据损坏"
                )
            prev += delta
            items.append(prev)
        if not items or prev != last_id:
            raise CorruptedDeltaError(
                f"块 {index} 末ID与跳跃表不一致（{prev} != {last_id}）：数据损坏"
            )
        self.stats.decoded_blocks += 1
        return items

    def decode_all(self) -> list[int]:
        """完整解码整个列表（每块都计入实际解码块数）。"""
        out: list[int] = []
        for i in range(len(self._skip_table)):
            out.extend(self._decode_block(i))
        return out

    def reset_stats(self) -> None:
        self.stats = DecodeStats()

    def cursor(self) -> "Cursor":
        return Cursor(self)

    def __len__(self) -> int:
        return self.count

    def __iter__(self):
        cursor = self.cursor()
        while (value := cursor.next()) is not None:
            yield value

    def __repr__(self) -> str:
        return f"PostingList(count={self.count}, blocks={len(self._skip_table)})"


class Cursor:
    """PostingList 上的单向游标。

    * next()          —— 移动到下一个文档ID，返回之；耗尽返回 None。
    * advance(target) —— 移动到第一个 >= target 的文档ID；
      target <= 当前ID 时不跳过任何内容，直接返回当前ID。
    """

    def __init__(self, pl: PostingList):
        self._pl = pl
        self._block_index = 0
        self._items: list[int] | None = None
        self._pos = 0
        self._started = False
        self.current: int | None = None

    @property
    def exhausted(self) -> bool:
        return self._started and self.current is None

    def _load(self, index: int) -> None:
        self._items = self._pl._decode_block(index)
        self._pos = 0
        self._block_index = index

    def next(self) -> int | None:
        pl = self._pl
        if self.exhausted:
            return None
        if not self._started:
            self._started = True
            if not pl._skip_table:
                self.current = None
                return None
            self._load(0)
        else:
            self._pos += 1
            if self._pos >= len(self._items):
                if self._block_index + 1 >= len(pl._skip_table):
                    self.current = None
                    return None
                self._load(self._block_index + 1)
        self.current = self._items[self._pos]
        return self.current

    def advance(self, target: int) -> int | None:
        pl = self._pl
        if self.exhausted:
            return None
        self._started = True
        if self.current is not None and target <= self.current:
            # advance 到当前ID（或更小值）不跳过
            return self.current
        # 整块跳过：块内最大ID仍小于 target，无需解码该块
        while (
            self._block_index < len(pl._skip_table)
            and pl._skip_table[self._block_index][0] < target
        ):
            self._block_index += 1
            self._items = None
            self._pos = 0
            pl.stats.skipped_blocks += 1
        if self._block_index >= len(pl._skip_table):
            self.current = None
            return None
        if self._items is None:
            self._load(self._block_index)
        while self._pos < len(self._items) and self._items[self._pos] < target:
            self._pos += 1
        # 块内最大ID >= target，此处必然指向 >= target 的元素
        self.current = self._items[self._pos]
        return self.current


# ---- 集合运算（输入为 PostingList，输出为严格递增的文档ID列表） ----


def intersect(a: PostingList, b: PostingList) -> list[int]:
    """交集：双游标 + advance 跳跃。"""
    ca, cb = a.cursor(), b.cursor()
    va, vb = ca.next(), cb.next()
    result = []
    while va is not None and vb is not None:
        if va < vb:
            va = ca.advance(vb)
        elif vb < va:
            vb = cb.advance(va)
        else:
            result.append(va)
            va = ca.next()
            vb = cb.next()
    return result


def union(a: PostingList, b: PostingList) -> list[int]:
    """并集：双游标归并。"""
    ca, cb = a.cursor(), b.cursor()
    va, vb = ca.next(), cb.next()
    result = []
    while va is not None or vb is not None:
        if vb is None or (va is not None and va < vb):
            result.append(va)
            va = ca.next()
        elif va is None or vb < va:
            result.append(vb)
            vb = cb.next()
        else:
            result.append(va)
            va = ca.next()
            vb = cb.next()
    return result


def difference(a: PostingList, b: PostingList) -> list[int]:
    """差集 a - b：a 顺序扫描，b 用 advance 追赶。"""
    ca, cb = a.cursor(), b.cursor()
    va, vb = ca.next(), cb.next()
    result = []
    while va is not None:
        if vb is None or va < vb:
            result.append(va)
            va = ca.next()
        elif vb < va:
            vb = cb.advance(va)
        else:
            va = ca.next()
            vb = cb.next()
    return result
