"""Command line interface for rchunk.

Usage:
    python -m rchunk chunk  INPUT [-o OUTPUT] [--buffer-size N]
    python -m rchunk verify DATA INDEX
    python -m rchunk locate INDEX POSITION
"""

from __future__ import annotations

import argparse
import hashlib
import sys

from . import core, index as index_mod


def _cmd_chunk(args: argparse.Namespace) -> int:
    output = args.output or args.input + ".chunk"
    chunker = core.Chunker()
    spans: list[tuple[int, int]] = []

    with open(args.input, "rb") as fh:
        while True:
            buf = fh.read(args.buffer_size)
            if not buf:
                break
            spans.extend(chunker.feed(buf))
    spans.extend(chunker.finish())

    records = []
    with open(args.input, "rb") as fh:
        for start, length in spans:
            fh.seek(start)
            digest = hashlib.sha256(fh.read(length)).digest()
            records.append(index_mod.ChunkEntry(start, length, digest))

    with open(output, "wb") as fh:
        fh.write(index_mod.dumps(records))
    total = records[-1].end if records else 0
    print(f"wrote {output}: {len(records)} chunks, {total} bytes")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    try:
        with open(args.index, "rb") as fh:
            entries = index_mod.loads(fh.read())
        with open(args.data, "rb") as fh:
            data = fh.read()
        index_mod.verify(entries, data)
    except index_mod.CorruptError as exc:
        where = f" (offset {exc.offset})" if exc.offset is not None else ""
        print(f"CORRUPT{where}: {exc}", file=sys.stderr)
        return 1
    total = entries[-1].end if entries else 0
    print(f"OK: {len(entries)} chunks, {total} bytes")
    return 0


def _cmd_locate(args: argparse.Namespace) -> int:
    try:
        with open(args.index, "rb") as fh:
            entries = index_mod.loads(fh.read())
        entry = index_mod.locate(entries, args.position)
    except index_mod.CorruptError as exc:
        print(f"CORRUPT: {exc}", file=sys.stderr)
        return 1
    print(
        f"position {args.position} -> chunk offset={entry.offset} "
        f"len={entry.length} sha256={entry.sha256.hex()}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rchunk", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_chunk = sub.add_parser("chunk", help="chunk a file and write a .chunk index")
    p_chunk.add_argument("input")
    p_chunk.add_argument("-o", "--output")
    p_chunk.add_argument("--buffer-size", type=int, default=65536)
    p_chunk.set_defaults(func=_cmd_chunk)

    p_verify = sub.add_parser("verify", help="verify data against a .chunk index")
    p_verify.add_argument("data")
    p_verify.add_argument("index")
    p_verify.set_defaults(func=_cmd_verify)

    p_locate = sub.add_parser("locate", help="find the chunk covering a byte position")
    p_locate.add_argument("index")
    p_locate.add_argument("position", type=int)
    p_locate.set_defaults(func=_cmd_locate)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if getattr(args, "buffer_size", 1) <= 0:
        print("buffer size must be positive", file=sys.stderr)
        return 2
    return args.func(args)
