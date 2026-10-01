"""Command line interface for rchunk."""
from __future__ import annotations

import argparse
import json
import sys

from . import core


def _cmd_chunk(args) -> int:
    with open(args.data, "rb") as fh:
        data = fh.read()
    index = core.build_index(data)
    with open(args.index, "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2)
        fh.write("\n")
    print("wrote %s: %d chunks, %d bytes"
          % (args.index, len(index["chunks"]), len(data)))
    return 0


def _cmd_verify(args) -> int:
    with open(args.data, "rb") as fh:
        data = fh.read()
    with open(args.index, "r", encoding="utf-8") as fh:
        index = json.load(fh)
    try:
        core.verify_index(data, index)
    except core.CorruptError as exc:
        print("Corrupt: %s" % exc, file=sys.stderr)
        return 1
    print("OK: %d chunks verified" % len(index["chunks"]))
    return 0


def _cmd_locate(args) -> int:
    with open(args.index, "r", encoding="utf-8") as fh:
        index = json.load(fh)
    try:
        entry = core.locate_chunk(index, args.offset)
    except core.CorruptError as exc:
        print("Corrupt: %s" % exc, file=sys.stderr)
        return 1
    print("offset=%d len=%d sha256=%s"
          % (entry["offset"], entry["len"], entry["sha256"]))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="rchunk",
        description="Content-defined chunking (W=48, 31-bit rolling sum, "
                    "cut on 13 low one-bits at len>=64, hard max 4096).")
    sub = parser.add_subparsers(dest="command", required=True)

    p_chunk = sub.add_parser("chunk", help="chunk DATA and write INDEX")
    p_chunk.add_argument("data", help="input data file")
    p_chunk.add_argument("index", help="output .chunk index file (JSON)")
    p_chunk.set_defaults(func=_cmd_chunk)

    p_verify = sub.add_parser(
        "verify", help="rebuild mode: verify DATA against INDEX")
    p_verify.add_argument("data", help="input data file")
    p_verify.add_argument("index", help=".chunk index file (JSON)")
    p_verify.set_defaults(func=_cmd_verify)

    p_locate = sub.add_parser(
        "locate", help="print the chunk covering OFFSET")
    p_locate.add_argument("index", help=".chunk index file (JSON)")
    p_locate.add_argument("offset", type=lambda s: int(s, 0),
                          help="byte offset (decimal or 0x..)")
    p_locate.set_defaults(func=_cmd_locate)

    args = parser.parse_args(argv)
    return args.func(args)
