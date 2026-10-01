"""colbit 解码器：惰性列加载、惰性 CRC 校验、批量增量解码。"""

from __future__ import annotations

import struct
import zlib
from typing import BinaryIO, Iterator, Sequence

from .errors import CrcError, FormatError
from .format import (
    COL_HEADER_SIZE,
    HEADER_SIZE,
    MAGIC,
    MAX_WIDTH,
    TYPE_INT,
    TYPE_STRING,
    column_data_size,
)


class _Column:
    __slots__ = ("type", "width", "crc", "offset", "size", "bits", "loaded")

    def __init__(self, ctype: int, width: int, crc: int, offset: int, size: int):
        self.type = ctype
        self.width = width
        self.crc = crc
        self.offset = offset
        self.size = size
        self.bits = 0  # 数据按小端整数整体载入，按位偏移切片
        self.loaded = False


class Decoder:
    """解码 colbit 文件。

    columns 为 None 时解码全部列；否则只加载/校验/解码所选列子集。
    iter_rows(batch) 每次最多物化 batch 行；首次取批前才读取并校验
    对应列的 CRC32，校验失败抛 CrcError（含准确列号）。
    """

    def __init__(self, fp: BinaryIO, columns: Sequence[int] | None = None):
        self._fp = fp
        header = fp.read(HEADER_SIZE)
        if len(header) < HEADER_SIZE or header[:4] != MAGIC:
            raise FormatError("bad magic or truncated header")
        self.ncols = header[4]
        (self.nrows,) = struct.unpack("<I", header[5:9])

        raw = fp.read(self.ncols * COL_HEADER_SIZE)
        if len(raw) < self.ncols * COL_HEADER_SIZE:
            raise FormatError("truncated column headers")

        self._columns: list[_Column] = []
        offset = HEADER_SIZE + self.ncols * COL_HEADER_SIZE
        for i in range(self.ncols):
            ctype, width, crc = struct.unpack(
                "<BBI", raw[i * COL_HEADER_SIZE : (i + 1) * COL_HEADER_SIZE]
            )
            if ctype == TYPE_STRING:
                raise FormatError(f"column {i}: string columns are forbidden")
            if ctype != TYPE_INT:
                raise FormatError(f"column {i}: unknown type {ctype}")
            if width > MAX_WIDTH:
                raise FormatError(f"column {i}: invalid width {width}")
            size = column_data_size(self.nrows, width)
            self._columns.append(_Column(ctype, width, crc, offset, size))
            offset += size
        self._data_end = offset

        if columns is None:
            self._selected = list(range(self.ncols))
        else:
            self._selected = []
            for c in columns:
                if not 0 <= c < self.ncols:
                    raise FormatError(f"column index {c} out of range")
                if c not in self._selected:
                    self._selected.append(c)
        self._row = 0

    @property
    def selected_columns(self) -> list[int]:
        return list(self._selected)

    def _load_column(self, idx: int) -> None:
        """读取列字节并做 CRC 校验；声明位长超出实际容量抛 FormatError。"""
        col = self._columns[idx]
        if col.loaded:
            return
        if col.size == 0:
            col.bits = 0
            col.loaded = True
            return
        self._fp.seek(col.offset)
        data = self._fp.read(col.size)
        if len(data) < col.size:
            raise FormatError(
                f"column {idx}: declared bit length {self.nrows * col.width} "
                f"exceeds actual capacity ({len(data) * 8} bits available)"
            )
        actual = zlib.crc32(data) & 0xFFFFFFFF
        if actual != col.crc:
            raise CrcError(idx, col.crc, actual)
        col.bits = int.from_bytes(data, "little")
        col.loaded = True

    def iter_rows(self, batch: int) -> Iterator[list[tuple[int, ...]]]:
        """每次产出至多 batch 行的列表；行内为所选列的值（按选择顺序）。"""
        if batch < 1:
            raise ValueError("batch must be >= 1")
        for idx in self._selected:
            self._load_column(idx)  # 读取该列任一批前完成惰性校验
        while self._row < self.nrows:
            n = min(batch, self.nrows - self._row)
            start = self._row
            rows: list[tuple[int, ...]] = []
            for r in range(start, start + n):
                row = []
                for idx in self._selected:
                    col = self._columns[idx]
                    if col.width == 0:
                        row.append(0)
                    else:
                        mask = (1 << col.width) - 1
                        row.append((col.bits >> (r * col.width)) & mask)
                rows.append(tuple(row))
            self._row += n
            yield rows


def loads(data: bytes, columns: Sequence[int] | None = None) -> Decoder:
    """便捷函数：从字节构造解码器。"""
    import io

    return Decoder(io.BytesIO(data), columns)
