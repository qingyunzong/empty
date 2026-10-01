"""colbit 命令行：pack / select / info。

  python -m colbit pack   --widths 1,7,9,32 -o out.clb < input.csv
  python -m colbit select out.clb --cols 0,2 --batch 100
  python -m colbit info   out.clb
"""

from __future__ import annotations

import argparse
import csv
import sys

from .errors import FormatError
from .reader import Decoder
from .writer import write_file


def _parse_cols(spec: str) -> list[int]:
    return [int(x) for x in spec.split(",") if x.strip() != ""]


def cmd_pack(args: argparse.Namespace) -> int:
    widths = _parse_cols(args.widths)
    rows = [r for r in csv.reader(args.input) if r]
    ncols = len(widths)
    for lineno, r in enumerate(rows, 1):
        if len(r) != ncols:
            print(f"line {lineno}: expected {ncols} fields, got {len(r)}",
                  file=sys.stderr)
            return 2
    columns = [[int(r[i]) for r in rows] for i in range(ncols)]
    try:
        write_file(args.output, columns, widths)
    except ValueError as exc:
        print(f"pack: {exc}", file=sys.stderr)
        return 2
    return 0


def cmd_select(args: argparse.Namespace) -> int:
    cols = _parse_cols(args.cols) if args.cols else None
    try:
        dec = Decoder(args.file, columns=cols)
        out = csv.writer(args.output)
        out.writerow(dec.selected_columns)
        for batch_rows in dec.iter_rows(args.batch):
            out.writerows(batch_rows)
    except FormatError as exc:
        print(f"select: {exc}", file=sys.stderr)
        return 2
    return 0


def cmd_info(args: argparse.Namespace) -> int:
    try:
        dec = Decoder(args.file)
    except FormatError as exc:
        print(f"info: {exc}", file=sys.stderr)
        return 2
    print(f"columns={dec.ncols} rows={dec.nrows}")
    for i, c in enumerate(dec._columns):
        print(f"  col {i}: type=int width={c.width} "
              f"crc32=0x{c.crc:08x} bytes={c.size}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="colbit")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pack", help="CSV -> colbit")
    p.add_argument("--widths", required=True, help="逗号分隔的位宽，如 1,7,9,32")
    p.add_argument("-o", "--output", type=argparse.FileType("wb"), required=True)
    p.add_argument("input", nargs="?", type=argparse.FileType("r"),
                   default=sys.stdin)
    p.set_defaults(func=cmd_pack)

    p = sub.add_parser("select", help="解码列子集并输出 CSV")
    p.add_argument("file", type=argparse.FileType("rb"))
    p.add_argument("--cols", help="逗号分隔的列号子集，缺省为全部列")
    p.add_argument("--batch", type=int, default=1024)
    p.add_argument("-o", "--output", type=argparse.FileType("w"),
                   default=sys.stdout)
    p.set_defaults(func=cmd_select)

    p = sub.add_parser("info", help="打印文件头信息")
    p.add_argument("file", type=argparse.FileType("rb"))
    p.set_defaults(func=cmd_info)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
