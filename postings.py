"""压缩文档ID差分列表（delta + varint）与跳跃块。

二进制格式（仅标准库，字节流）：
    流 = 块*
    块 = varint(条目数 count)
         varint(块内最大文档ID last_doc_id)   -- 跳跃指针目标
         varint(负载字节数 payload_len)
         payload_len 字节的 varint 差分序列
    差分 = 当前文档ID - 前一文档ID（全局前一ID，首条相对 -1），必须 >= 1。

跳跃块语义：块头中的 last_doc_id 是块内最大文档ID。advance(target) 时，
若 last_doc_id < target，则整块跳过（不解码、不计入 blocks_decoded）。
"""
from __future__ import annotations

from typing import Iterable, Iterator, Optional

BLOCK_SIZE = 8


class CorruptPostingsError(ValueError):
    """差分数据损坏：差分非正、块目标倒退、数据截断或校验不一致。"""


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


def _decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise CorruptPostingsError("varint 数据截断")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise CorruptPostingsError("varint 超长")


def encode(doc_ids: Iterable[int], block_size: int = BLOCK_SIZE) -> bytes:
    """把严格递增的文档ID序列编码为带跳跃块的差分字节流。"""
    if block_size < 1:
        raise ValueError("block_size 必须 >= 1")
    ids = list(doc_ids)
    prev = -1
    for doc_id in ids:
        if not isinstance(doc_id, int) or isinstance(doc_id, bool):
            raise TypeError(f"文档ID必须是 int，得到 {doc_id!r}")
        if doc_id <= prev:
            raise ValueError(f"文档ID必须严格递增：{doc_id} 出现在 {prev} 之后")
        prev = doc_id

    out = bytearray()
    prev = -1
    for start in range(0, len(ids), block_size):
        block = ids[start:start + block_size]
        payload = bytearray()
        for doc_id in block:
            payload += _encode_varint(doc_id - prev)
            prev = doc_id
        out += _encode_varint(len(block))
        out += _encode_varint(block[-1])
        out += _encode_varint(len(payload))
        out += payload
    return bytes(out)


class PostingsReader:
    """压缩列表上的单向游标，支持 next() 与 advance(target)。

    属性 blocks_decoded 统计实际解码的块数（被整块跳过的不计）。
    """

    def __init__(self, data: bytes):
        self._data = bytes(data)
        self._pos = 0
        self._last = -1            # 已消费（解码或跳过）到的最大文档ID
        self.current: Optional[int] = None
        self.exhausted = len(self._data) == 0
        self.blocks_decoded = 0
        self._payload = b""
        self._payload_pos = 0
        self._block_left = 0       # 当前已解码块剩余条目
        self._block_last = -1      # 当前已解码块头声明的最大ID（用于校验）
        self._pending: Optional[tuple[int, int, int]] = None  # 已读头未消费的块

    def _load_header(self) -> None:
        if self._pending is not None or self._block_left > 0 or self.exhausted:
            return
        if self._pos >= len(self._data):
            self.exhausted = True
            return
        count, self._pos = _decode_varint(self._data, self._pos)
        last, self._pos = _decode_varint(self._data, self._pos)
        plen, self._pos = _decode_varint(self._data, self._pos)
        if count < 1:
            raise CorruptPostingsError("块条目数必须 >= 1")
        if last <= self._last:
            raise CorruptPostingsError(
                f"块跳跃目标倒退：块最大ID {last} <= 已消费ID {self._last}")
        if self._pos + plen > len(self._data):
            raise CorruptPostingsError("块负载截断")
        self._pending = (count, last, plen)

    def _skip_block(self) -> None:
        count, last, plen = self._pending
        self._pos += plen
        self._last = last
        self._pending = None

    def _decode_block(self) -> None:
        count, last, plen = self._pending
        self._payload = self._data[self._pos:self._pos + plen]
        self._pos += plen
        self._payload_pos = 0
        self._block_left = count
        self._block_last = last
        self._pending = None
        self.blocks_decoded += 1

    def _next_in_block(self) -> int:
        delta, self._payload_pos = _decode_varint(self._payload, self._payload_pos)
        if delta < 1:
            raise CorruptPostingsError(
                f"差分必须为正整数（严格递增），得到 {delta}")
        self._last += delta
        self._block_left -= 1
        if self._block_left == 0 and self._last != self._block_last:
            raise CorruptPostingsError(
                f"块校验失败：解码末ID {self._last} != 块头声明 {self._block_last}")
        return self._last

    def next(self) -> Optional[int]:
        """前进到下一个文档ID并返回；耗尽返回 None。"""
        if self.exhausted:
            return None
        if self._block_left == 0:
            self._load_header()
            if self.exhausted:
                self.current = None
                return None
            self._decode_block()
        self.current = self._next_in_block()
        return self.current

    def advance(self, target: int) -> Optional[int]:
        """前进到第一个 >= target 的文档ID并返回；耗尽返回 None。

        target <= current 时不移动（不跳过当前ID）。块头最大ID < target
        的块被整块跳过，不计入 blocks_decoded。
        """
        if self.exhausted:
            return None
        if self.current is not None and self.current >= target:
            return self.current
        while True:
            if self._block_left == 0:
                self._load_header()
                if self.exhausted:
                    self.current = None
                    return None
                if self._pending[1] < target:
                    self._skip_block()
                    continue
                self._decode_block()
            while self._block_left > 0:
                doc_id = self._next_in_block()
                if doc_id >= target:
                    self.current = doc_id
                    return doc_id

    def __iter__(self) -> Iterator[int]:
        while True:
            doc_id = self.next()
            if doc_id is None:
                return
            yield doc_id


class PostingsList:
    """不可变的压缩文档ID列表。"""

    def __init__(self, doc_ids: Iterable[int] = (), block_size: int = BLOCK_SIZE):
        self.block_size = block_size
        self._data = encode(doc_ids, block_size)

    @classmethod
    def from_bytes(cls, data: bytes) -> "PostingsList":
        obj = cls.__new__(cls)
        obj.block_size = BLOCK_SIZE
        obj._data = bytes(data)
        return obj

    def to_bytes(self) -> bytes:
        return self._data

    def reader(self) -> PostingsReader:
        return PostingsReader(self._data)

    def to_list(self) -> list[int]:
        return list(self.reader())

    def __iter__(self) -> Iterator[int]:
        return iter(self.to_list())

    def __len__(self) -> int:
        return sum(1 for _ in self.reader())

    def __eq__(self, other) -> bool:
        return isinstance(other, PostingsList) and self._data == other._data

    def __repr__(self) -> str:
        return f"PostingsList({self.to_list()!r})"


def intersect(a: PostingsList, b: PostingsList) -> PostingsList:
    """交集：双游标 + advance 跳跃。"""
    ra, rb = a.reader(), b.reader()
    out = []
    ca, cb = ra.next(), rb.next()
    while ca is not None and cb is not None:
        if ca == cb:
            out.append(ca)
            ca, cb = ra.next(), rb.next()
        elif ca < cb:
            ca = ra.advance(cb)
        else:
            cb = rb.advance(ca)
    return PostingsList(out)


def union(a: PostingsList, b: PostingsList) -> PostingsList:
    """并集：归并。"""
    ra, rb = a.reader(), b.reader()
    out = []
    ca, cb = ra.next(), rb.next()
    while ca is not None or cb is not None:
        if cb is None or (ca is not None and ca < cb):
            out.append(ca)
            ca = ra.next()
        elif ca is None or cb < ca:
            out.append(cb)
            cb = rb.next()
        else:
            out.append(ca)
            ca, cb = ra.next(), rb.next()
    return PostingsList(out)


def difference(a: PostingsList, b: PostingsList) -> PostingsList:
    """差集：a 中去掉 b 出现的ID。"""
    ra, rb = a.reader(), b.reader()
    out = []
    ca, cb = ra.next(), rb.next()
    while ca is not None:
        if cb is None:
            out.append(ca)
            ca = ra.next()
        elif ca < cb:
            out.append(ca)
            ca = ra.next()
        elif ca > cb:
            cb = rb.advance(ca)
        else:
            ca, cb = ra.next(), rb.next()
    return PostingsList(out)
