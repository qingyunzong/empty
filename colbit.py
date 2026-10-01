"""colbit: a tiny columnar bit-packed integer format.

File layout (all integers little-endian)::

    magic   : 8 bytes  b"COLBIT01"
    C       : u32      number of columns
    R       : u32      number of rows
    per column header (C times):
        type  : u8     0 = int, 1 = string (string columns are forbidden)
        w     : u8     bit width, 0..32 (0 means the column is all zeros
                       and stores no data)
        crc32 : u32    crc32 of this column's data section
    data sections, one per column, concatenated in column order.
    Section i is ceil(R * w_i / 8) bytes; values are packed as a
    little-endian bit stream (value bit j -> stream bit i*w + j),
    the final partial byte is zero-padded.
"""

from __future__ import annotations

import argparse
import binascii
import random
import struct
import sys

MAGIC = b"COLBIT01"
TYPE_INT = 0
TYPE_STRING = 1
MAX_WIDTH = 32

_HEADER = struct.Struct("<8sII")
_COL_HEADER = struct.Struct("<BBI")


class FormatError(Exception):
    """Raised when a colbit file is malformed or corrupt."""


class CrcMismatchError(FormatError):
    """Raised when a column's data fails its lazy crc32 check."""

    def __init__(self, column: int):
        self.column = column
        super().__init__(f"column {column}: crc32 mismatch")


def column_data_size(rows: int, width: int) -> int:
    """Number of storage bytes for ``rows`` values of ``width`` bits."""
    return (rows * width + 7) // 8


def pack_values(values, width: int) -> bytes:
    """Pack integers into a little-endian bit stream of ``width`` bits each."""
    if width == 0:
        return b""
    out = bytearray()
    acc = 0
    nbits = 0
    for v in values:
        acc |= v << nbits
        nbits += width
        while nbits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            nbits -= 8
    if nbits:
        out.append(acc & 0xFF)  # final partial byte, zero-padded above
    return bytes(out)


class _BitReader:
    """Incremental little-endian bit-stream reader over a bytes section."""

    __slots__ = ("data", "pos")

    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0  # bit position

    def read(self, n: int) -> int:
        if n == 0:
            return 0
        byte = self.pos >> 3
        off = self.pos & 7
        need = (off + n + 7) // 8
        chunk = int.from_bytes(self.data[byte:byte + need], "little")
        value = (chunk >> off) & ((1 << n) - 1)
        self.pos += n
        return value


def _validate_widths(widths) -> None:
    for w in widths:
        if not isinstance(w, int) or not 0 <= w <= MAX_WIDTH:
            raise ValueError(f"invalid bit width {w!r}: must be 0..{MAX_WIDTH}")


def write_file(path, columns, widths) -> None:
    """Write integer ``columns`` (list of equal-length sequences) to ``path``."""
    if len(columns) != len(widths):
        raise ValueError("columns and widths must have the same length")
    _validate_widths(widths)
    rows = len(columns[0]) if columns else 0
    for col in columns:
        if len(col) != rows:
            raise ValueError("all columns must have the same row count")
    sections = []
    for col, w in zip(columns, widths):
        limit = 1 << w
        for v in col:
            if not isinstance(v, int) or not 0 <= v < limit:
                raise ValueError(
                    f"value {v!r} does not fit in {w} bits"
                )
        sections.append(pack_values(col, w))
    header = _HEADER.pack(MAGIC, len(columns), rows)
    col_headers = b"".join(
        _COL_HEADER.pack(TYPE_INT, w, binascii.crc32(sec) & 0xFFFFFFFF)
        for sec, w in zip(sections, widths)
    )
    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(col_headers)
        for sec in sections:
            fh.write(sec)


class ColbitReader:
    """Decoder for colbit files.

    ``columns`` optionally restricts decoding to a subset of column
    indices; unselected columns are neither read nor crc-checked.
    """

    def __init__(self, path, columns=None):
        with open(path, "rb") as fh:
            blob = fh.read()
        if len(blob) < _HEADER.size:
            raise FormatError("file too short for colbit header")
        magic, ncols, nrows = _HEADER.unpack_from(blob, 0)
        if magic != MAGIC:
            raise FormatError(f"bad magic {magic!r}")
        off = _HEADER.size
        if len(blob) < off + ncols * _COL_HEADER.size:
            raise FormatError("file too short for column headers")
        types = []
        widths = []
        crcs = []
        for _ in range(ncols):
            ctype, w, crc = _COL_HEADER.unpack_from(blob, off)
            off += _COL_HEADER.size
            if ctype == TYPE_STRING:
                raise FormatError("string columns are forbidden")
            if ctype != TYPE_INT:
                raise FormatError(f"unknown column type {ctype}")
            if w > MAX_WIDTH:
                raise FormatError(f"invalid bit width {w}")
            types.append(ctype)
            widths.append(w)
            crcs.append(crc)
        offsets = []
        total_bits = 0
        for w in widths:
            offsets.append(off)
            size = column_data_size(nrows, w)
            off += size
            total_bits += nrows * w
        if len(blob) < off:
            raise FormatError(
                f"declared bit length ({total_bits} bits) exceeds actual "
                f"capacity ({(len(blob) - offsets[0] if offsets else 0) * 8} bits)"
            )
        self._blob = blob
        self.ncols = ncols
        self.nrows = nrows
        self.widths = widths
        self._crcs = crcs
        self._offsets = offsets
        if columns is None:
            self._selected = list(range(ncols))
        else:
            self._selected = list(columns)
            for c in self._selected:
                if not 0 <= c < ncols:
                    raise ValueError(f"column index {c} out of range")
        self._verified = set()

    def _section(self, col: int) -> bytes:
        start = self._offsets[col]
        end = start + column_data_size(self.nrows, self.widths[col])
        return self._blob[start:end]

    def _verify(self, col: int) -> None:
        if col in self._verified:
            return
        crc = binascii.crc32(self._section(col)) & 0xFFFFFFFF
        if crc != self._crcs[col]:
            raise CrcMismatchError(col)
        self._verified.add(col)

    def iter_rows(self, batch: int):
        """Yield lists of row tuples, materializing at most ``batch`` rows
        per yield. Only the selected columns are decoded, and each column's
        crc32 is checked lazily before its first batch is read."""
        if batch <= 0:
            raise ValueError("batch must be a positive integer")

        def _generate():
            for col in self._selected:
                self._verify(col)
            readers = [
                (_BitReader(self._section(col)), self.widths[col])
                for col in self._selected
            ]
            produced = 0
            while produced < self.nrows:
                n = min(batch, self.nrows - produced)
                rows = []
                for _ in range(n):
                    rows.append(tuple(br.read(w) for br, w in readers))
                yield rows
                produced += n

        return _generate()


def _cmd_create(args) -> int:
    widths = [int(part) for part in args.widths.split(",") if part != ""]
    rng = random.Random(args.seed)
    columns = [
        [rng.getrandbits(w) if w else 0 for _ in range(args.rows)]
        for w in widths
    ]
    write_file(args.file, columns, widths)
    print(f"wrote {args.rows} rows x {len(widths)} columns to {args.file}")
    return 0


def _cmd_select(args) -> int:
    columns = [int(c) for c in args.columns] if args.columns else None
    reader = ColbitReader(args.file, columns=columns)
    for rows in reader.iter_rows(args.batch):
        for row in rows:
            print(",".join(str(v) for v in row))
    return 0


def _cmd_info(args) -> int:
    reader = ColbitReader(args.file)
    print(f"columns: {reader.ncols}")
    print(f"rows: {reader.nrows}")
    print(f"widths: {','.join(str(w) for w in reader.widths)}")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="colbit", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_create = sub.add_parser("create", help="create a random colbit file")
    p_create.add_argument("file")
    p_create.add_argument("--widths", required=True,
                          help="comma-separated bit widths, e.g. 1,7,9,32")
    p_create.add_argument("--rows", type=int, default=100)
    p_create.add_argument("--seed", type=int, default=0)
    p_create.set_defaults(func=_cmd_create)

    p_select = sub.add_parser("select", help="decode and print rows")
    p_select.add_argument("file")
    p_select.add_argument("columns", nargs="*",
                          help="column indices to decode (default: all)")
    p_select.add_argument("--batch", type=int, default=64)
    p_select.set_defaults(func=_cmd_select)

    p_info = sub.add_parser("info", help="print file header info")
    p_info.add_argument("file")
    p_info.set_defaults(func=_cmd_info)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (FormatError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
