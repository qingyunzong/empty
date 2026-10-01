"""CLI: python -m midx build|verify|root ...

Exit codes:
    0  success / verification passed
    1  verification failed (bad blocks found)
    2  usage or I/O error
    4  index file corrupt (IndexError: bad magic, crc32 mismatch, truncation)
"""

from __future__ import annotations

import argparse
import os
import sys

from . import core

EXIT_OK = 0
EXIT_BAD_DATA = 1
EXIT_USAGE = 2
EXIT_INDEX_CORRUPT = 4


def _index_path(args) -> str:
    return args.index if args.index else args.file + ".index"


def cmd_build(args) -> int:
    block_size = args.block_size
    if block_size <= 0:
        print("error: --block-size must be positive", file=sys.stderr)
        return EXIT_USAGE
    file_size = os.path.getsize(args.file)
    if file_size <= 0:
        print("error: empty file cannot be indexed", file=sys.stderr)
        return EXIT_USAGE
    with open(args.file, "rb") as f:
        leaves = core.compute_leaf_hashes(f, block_size, file_size)
    blob = core.build_index_bytes(block_size, file_size, leaves)
    path = _index_path(args)
    with open(path, "wb") as f:
        f.write(blob)
    root = core.build_levels(leaves)[-1][0]
    print(
        f"built {path}: blocks={len(leaves)} block_size={block_size} "
        f"file_size={file_size} root={root.hex()}"
    )
    return EXIT_OK


def _load_verified_index(args):
    """Load index or print error and return None plus an exit code."""
    path = _index_path(args)
    try:
        return core.load_index(path), None
    except IndexError as exc:
        print(f"index error: {path}: {exc}", file=sys.stderr)
        return None, EXIT_INDEX_CORRUPT
    except OSError as exc:
        print(f"io error: {exc}", file=sys.stderr)
        return None, EXIT_USAGE


def cmd_verify(args) -> int:
    index, err = _load_verified_index(args)
    if err is not None:
        return err
    offset = args.offset if args.offset is not None else 0
    length = args.length if args.length is not None else index.file_size - offset
    if offset < 0 or length < 0:
        print("error: --offset/--length must be >= 0", file=sys.stderr)
        return EXIT_USAGE
    try:
        with open(args.file, "rb") as f:
            bad = core.verify_range(f, index, offset, length)
    except OSError as exc:
        print(f"io error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if bad:
        first = bad[0]
        print(
            f"BAD: first bad block {first} "
            f"(offset {first * index.block_size}); "
            f"bad blocks ({len(bad)}): {' '.join(map(str, bad))}"
        )
        return EXIT_BAD_DATA
    first_block = offset // index.block_size
    last_block = min((offset + max(length, 1) - 1) // index.block_size, index.leaf_count - 1)
    print(
        f"OK: blocks {first_block}..{last_block} verified "
        f"against root {index.root.hex()}"
    )
    return EXIT_OK


def cmd_root(args) -> int:
    index, err = _load_verified_index(args)
    if err is not None:
        return err
    print(index.root.hex())
    return EXIT_OK


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="midx", description="Merkle index over fixed-size file blocks (sha256)."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_build = sub.add_parser("build", help="build FILE.index")
    p_build.add_argument("file")
    p_build.add_argument(
        "--block-size",
        type=int,
        default=core.DEFAULT_BLOCK_SIZE,
        help="block size in bytes, need not be a power of two "
        f"(default: {core.DEFAULT_BLOCK_SIZE})",
    )
    p_build.add_argument("--index", help="index output path (default: FILE.index)")
    p_build.set_defaults(func=cmd_build)

    p_verify = sub.add_parser("verify", help="verify FILE against its index")
    p_verify.add_argument("file")
    p_verify.add_argument("--index", help="index path (default: FILE.index)")
    p_verify.add_argument("--offset", type=int, default=None, help="start byte (default: 0)")
    p_verify.add_argument("--length", type=int, default=None, help="byte count (default: to EOF)")
    p_verify.set_defaults(func=cmd_verify)

    p_root = sub.add_parser("root", help="print the Merkle root hex")
    p_root.add_argument("file")
    p_root.add_argument("--index", help="index path (default: FILE.index)")
    p_root.set_defaults(func=cmd_root)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except IndexError as exc:
        print(f"index error: {exc}", file=sys.stderr)
        return EXIT_INDEX_CORRUPT


if __name__ == "__main__":
    sys.exit(main())
