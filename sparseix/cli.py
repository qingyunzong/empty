"""Command line interface for sparseix."""

from __future__ import annotations

import argparse
import sys

from .core import IndexCorrupt, SparseFile


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sparseix",
        description="Manage sparse file region indexes (.idx sidecar files).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_write = sub.add_parser("write", help="write bytes at an offset")
    p_write.add_argument("file", help="target data file")
    p_write.add_argument("offset", type=int, help="byte offset (>= 0)")
    p_write.add_argument("data", help="payload text (or hex with --hex)")
    p_write.add_argument("--hex", action="store_true", help="data is hex encoded")

    p_read = sub.add_parser("read", help="read bytes (holes read as 0x00)")
    p_read.add_argument("file", help="target data file")
    p_read.add_argument("offset", type=int, help="byte offset (>= 0)")
    p_read.add_argument("length", type=int, help="number of bytes")
    p_read.add_argument("--hex", action="store_true", help="print hex to stdout")

    p_check = sub.add_parser("check", help="validate index consistency")
    p_check.add_argument("file", help="target data file")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "write":
            data = bytes.fromhex(args.data) if args.hex else args.data.encode()
            sf = SparseFile(args.file)
            sf.write(args.offset, data)
            print(
                f"wrote {len(data)} byte(s) at offset {args.offset}; "
                f"segments={len(sf.segments)}"
            )
        elif args.command == "read":
            sf = SparseFile(args.file)
            out = sf.read(args.offset, args.length)
            if args.hex:
                print(out.hex())
            else:
                sys.stdout.buffer.write(out)
        elif args.command == "check":
            sf = SparseFile(args.file)
            sf.check()
            print(f"OK: {len(sf.segments)} segment(s), index consistent")
    except (IndexCorrupt, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
