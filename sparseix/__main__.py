"""Command line interface: ``python -m sparseix <write|read|check> ...``."""

from __future__ import annotations

import argparse
import sys

from . import core


def _cmd_write(args: argparse.Namespace) -> int:
    data = bytes.fromhex(args.hexdata)
    core.write(args.file, args.offset, data)
    print(f"wrote {len(data)} bytes at offset {args.offset} in {args.file}")
    return 0


def _cmd_read(args: argparse.Namespace) -> int:
    data = core.read(args.file, args.offset, args.length)
    print(data.hex())
    return 0


def _cmd_check(args: argparse.Namespace) -> int:
    count = core.check(args.file)
    print(f"OK: {args.file} ({count} segment(s))")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sparseix", description="Sparse-file segment index manager"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_write = sub.add_parser("write", help="write hex data at an offset")
    p_write.add_argument("file", help="target data file")
    p_write.add_argument("offset", type=int, help="byte offset")
    p_write.add_argument("hexdata", help="data as a hex string")
    p_write.set_defaults(func=_cmd_write)

    p_read = sub.add_parser("read", help="read bytes (holes read as 00)")
    p_read.add_argument("file", help="target data file")
    p_read.add_argument("offset", type=int, help="byte offset")
    p_read.add_argument("length", type=int, help="number of bytes")
    p_read.set_defaults(func=_cmd_read)

    p_check = sub.add_parser("check", help="validate index and crc32s")
    p_check.add_argument("file", help="target data file")
    p_check.set_defaults(func=_cmd_check)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (core.IndexCorrupt, ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
