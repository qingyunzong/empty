"""colbit 写入器：整数列按 w 位小端位流紧凑打包。"""

from __future__ import annotations

import struct
import zlib
from typing import BinaryIO, Iterable, Sequence

from .format import (
    COL_HEADER_SIZE,
    HEADER_SIZE,
    MAGIC,
    MAX_WIDTH,
    TYPE_INT,
    TYPE_STRING,
    column_data_size,
)


def pack_column(values: Iterable[int], width: int) -> bytes:
    """把整数列打包为 w 位小端位流字节；w=0 返回空字节（全零列）。"""
    if width == 0:
        return b""
    if not 1 <= width <= MAX_WIDTH:
        raise ValueError(f"invalid width {width}: must be 0..{MAX_WIDTH}")
    limit = 1 << width
    out = bytearray()
    acc = 0
    accbits = 0
    for v in values:
        if not isinstance(v, int) or v < 0 or v >= limit:
            raise ValueError(f"value {v!r} does not fit in {width} bits")
        acc |= v << accbits
        accbits += width
        while accbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            accbits -= 8
    if accbits:
        out.append(acc & 0xFF)  # 末尾不足一字节补零
    return bytes(out)


def write_file(
    fp: BinaryIO,
    columns: Sequence[Sequence[int]],
    widths: Sequence[int],
    types: Sequence[int] | None = None,
) -> None:
    """写入完整 colbit 文件。字符串列（type=1）禁止。"""
    ncols = len(columns)
    if len(widths) != ncols:
        raise ValueError("widths length must match number of columns")
    if types is None:
        types = [TYPE_INT] * ncols
    if len(types) != ncols:
        raise ValueError("types length must match number of columns")
    if not 0 <= ncols <= 0xFF:
        raise ValueError("column count must fit in u8")

    nrows = len(columns[0]) if ncols else 0
    for col in columns:
        if len(col) != nrows:
            raise ValueError("all columns must have the same row count")

    packed: list[bytes] = []
    for i, (col, w, t) in enumerate(zip(columns, widths, types)):
        if t == TYPE_STRING:
            raise ValueError(f"column {i}: string columns are forbidden")
        if t != TYPE_INT:
            raise ValueError(f"column {i}: unknown type {t}")
        if not 0 <= w <= MAX_WIDTH:
            raise ValueError(f"column {i}: invalid width {w}")
        packed.append(pack_column(col, w))
        if len(packed[-1]) != column_data_size(nrows, w):
            raise AssertionError("internal: packed size mismatch")

    fp.write(MAGIC)
    fp.write(struct.pack("<B", ncols))
    fp.write(struct.pack("<I", nrows))
    for i, (w, t) in enumerate(zip(widths, types)):
        crc = zlib.crc32(packed[i]) & 0xFFFFFFFF
        fp.write(struct.pack("<BBI", t, w, crc))
    for data in packed:
        fp.write(data)


def dumps(
    columns: Sequence[Sequence[int]],
    widths: Sequence[int],
    types: Sequence[int] | None = None,
) -> bytes:
    """便捷函数：返回完整文件字节。"""
    import io

    buf = io.BytesIO()
    write_file(buf, columns, widths, types)
    return buf.getvalue()
